/**
 * A music bot for Tusile, and an example of writing one.
 *
 * It searches Openverse for openly licensed music, queues what it finds, and plays it into
 * a voice channel. Everything it can play is Creative Commons, which is the point: a music
 * bot you can actually run and share without a takedown notice, and a worked example of the
 * parts of the bot API that are hard to find your way around from the docs alone, which are
 * voice and deferred interactions.
 *
 * Configure with CORE_SERVER_URL, BOT_KEY and BOT_SECRET. Nothing else. ffmpeg has to be on
 * the path; the Dockerfile puts it there.
 *
 * https://github.com/krzotki/tusile-music-bot
 */

import { spawn } from 'node:child_process';

import { Bot, toMask } from '@tusile/bot';

import { definitions, handle, nowPlayingLine } from './commands.js';
import { search } from './search.js';
import { SEEDS } from './radio.js';
import { createStationCache } from './stations.js';
import { Session, connectToRoom } from './player.js';

/**
 * What this bot asks a community for.
 *
 * Whoever adds it is shown this list and ticks what they allow. It is a request, not a
 * grant. Four things: see the channel it was asked in, say what is playing, sit in a voice
 * channel, and be heard in one.
 *
 * Nothing else, and deliberately nothing that can change the community. A music bot that
 * can manage channels is a music bot that can delete them, and the only protection against
 * the day its token leaks is that nobody ever gave it the power.
 */
const NEEDS = ['view_channel', 'send_messages', 'connect', 'speak'];

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const short = (serverId) => String(serverId).slice(0, 8);

/**
 * The live sessions, one per voice channel, across every community.
 *
 * Keyed by community and channel together. The bot is installed in several places and
 * there is no reason two communities cannot be listening to different things, which keying
 * by channel alone would have made impossible in a way nobody would have noticed until the
 * second community tried.
 */
export class Sessions {
  constructor({ connect = connectToRoom, spawnImpl = spawn } = {}) {
    this.map = new Map();
    this.connect = connect;
    this.spawn = spawnImpl;
  }

  key(serverId, channelId) {
    return `${serverId}:${channelId}`;
  }

  /**
   * The session for a channel, started if it is not running.
   *
   * A stopped session is replaced rather than reused: `stopped` is permanent on purpose, so
   * that a stop which is still tearing the room down cannot be handed a new track and
   * resurrect itself halfway through hanging up.
   */
  for(serverId, channelId, { server, announce }) {
    const key = this.key(serverId, channelId);
    const existing = this.map.get(key);
    if (existing && !existing.stopped) return existing;

    const session = new Session({
      server,
      channelId,
      log: (line) => log(`[${short(serverId)}] ${line}`),
      connect: this.connect,
      spawn: this.spawn,
      announce,
    });
    this.map.set(key, session);
    return session;
  }

  /** Whichever session in this community is doing something, or null. */
  liveIn(serverId) {
    for (const [key, session] of this.map) {
      if (!key.startsWith(`${serverId}:`)) continue;
      if (session.stopped) continue;
      if (session.running || session.queue.size > 0) return session;
    }
    return null;
  }

  /** Let go of a community's sessions, stopping anything still playing. */
  async forget(serverId) {
    for (const [key, session] of [...this.map]) {
      if (!key.startsWith(`${serverId}:`)) continue;
      this.map.delete(key);
      await session.stop().catch(() => {});
    }
  }
}

/**
 * Run one command.
 *
 * Exported so the tests can drive the real path with a fake interaction, which is the only
 * way to catch an answer that is built correctly and then never sent.
 */
export async function runCommand(name, i, sessions, deps = {}) {
  const serverId = i.server.serverId;
  const ctx = {
    userId: i.userId,
    channelId: i.channelId,
    // Where they are sitting, straight off the interaction.
    //
    // The named field arrived in @tusile/bot 0.5.0; `raw` is the frame as the community
    // sent it, so this works on 0.4.0 too and the fallback can go once every bot here is
    // past it. A community older than the field sends nothing either way, which reads as
    // "they did not say" rather than "nowhere".
    userVoiceChannelId: i.userVoiceChannelId || i.raw?.user_voice_channel_id || '',
    server: i.server,
    log: (line) => log(`[${short(serverId)}] ${line}`),
    // The function itself, not a wrapper around it.
    //
    // This was `(query) => search(query)`, which drops every argument after the first. The
    // radio asks with `withTotal` and got an array back instead of a total, so it found
    // nothing, every time, in production. Every test passed because each supplied a fake
    // search that honoured the options the real wiring was discarding: the fake was more
    // capable than the thing it stood in for.
    search: contextSearch(deps),
    // The warmed stations, so the first batch of a radio is already in hand.
    stations: deps.stations ?? sharedStations,
    // The defer is the only place that can decide who an answer is for: it delivers
    // nothing, and the edit carrying the answer later has no type of its own.
    defer: (options) => i.defer(options),
    update: (content) => i.editReply(content),
    sessionFor: (channelId) =>
      sessions.for(serverId, channelId, {
        server: i.server,
        // Posted where the command was run, not where the music is. A voice channel in
        // Tusile has its own text, but the person asked from somewhere, and an answer in a
        // room they are not looking at is an answer nobody reads.
        announce: (entry) => i.server.send(i.channelId, { content: nowPlayingLine(entry) }),
      }),
    liveSession: () => sessions.liveIn(serverId),
  };

  const result = await handle({ command: name, options: i.options || {} }, ctx);
  // A null result means the handler already spoke for itself, over however long it needed.
  if (!result) return null;
  await i.reply({ content: result.content }, { ephemeral: result.type === 'ephemeral' });
  return result;
}

/**
 * The search a command context gets.
 *
 * Its own function so a test can say "and with no deps, this is the real one", which is
 * the only thing that would have caught the wrapper that dropped the options.
 */
export function contextSearch(deps = {}) {
  return deps.search ?? search;
}

/**
 * The stations, kept warm for the whole process.
 *
 * One cache across every community: the catalogue is the same everywhere, and eighteen
 * stations per community would be eighteen requests per community at a service that takes
 * the better part of half a minute to answer a cold one.
 */
const sharedStations = createStationCache({
  stations: SEEDS,
  search: (station) => search(station, { limit: 5 }),
  log,
});

/**
 * Attach everything to a bot.
 *
 * Separated from `main` so a test can wire a fake bot and watch what gets registered. Every
 * command this bot defines is registered here in one loop rather than by hand, so a
 * definition added without a handler is impossible rather than merely unlikely.
 */
export function wire(bot, { sessions = new Sessions(), deps = {} } = {}) {
  for (const definition of definitions) {
    bot.command(definition, (i) => runCommand(definition.name, i, sessions, deps));
  }

  // The address, not just the name. A silent bot and a bot talking to the box a community
  // has moved away from look identical from outside.
  bot.on('ready', (me, server) => {
    log(`[${short(server.serverId)}] connected as ${me.name} at ${server.apiUrl}`);
  });

  bot.on('left', (serverId) => {
    log(`[${short(serverId)}] no longer installed here`);
    sessions.forget(serverId).catch(() => {});
  });

  return sessions;
}

export async function main() {
  const bot = new Bot({
    permissions: toMask(NEEDS),
    onError: (err, context) =>
      log(context?.serverId ? `[${short(context.serverId)}] ${err.message}` : err.message),
  });

  const sessions = wire(bot);

  // Before the first command, and without blocking it: a station that is not warm yet is
  // simply fetched when asked for, slowly, which is what every station used to be.
  sharedStations.warm().catch((err) => log(`warming stations: ${err.message}`));

  const shutdown = async () => {
    log('shutting down');
    // Leave every channel before the process goes. Without this the community is left
    // showing a bot with a live microphone until its socket times out, which is a minute of
    // a bot that appears to be playing silence.
    await Promise.all([...sessions.map.values()].map((s) => s.stop().catch(() => {})));
    await bot.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await bot.start();
  log('listening');
}
