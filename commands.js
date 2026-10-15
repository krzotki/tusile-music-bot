/**
 * The four things you can ask this bot to do.
 *
 * Every answer that names a track names its licence too. These are Creative Commons
 * recordings and all but the CC0 ones require credit wherever they are used, so the credit
 * is part of playing them rather than something the README asks you to remember.
 */

import { search, credit } from './search.js';
import { clock, totalDuration } from './queue.js';

/** Where this bot lives, so somebody who likes it can go and read it. */
const REPO = 'https://github.com/krzotki/tusile-music-bot';

const definitions = [
  {
    name: 'play',
    description: 'Search for music and play it in a voice channel',
    options: [
      {
        name: 'query',
        type: 'string',
        description: 'What to look for, such as lofi piano or 8 bit chiptune',
        required: true,
      },
      {
        name: 'channel',
        type: 'channel',
        description: 'Which voice channel',
        required: true,
        // Without this the picker offers text channels too, and choosing one gets as far
        // as the bot trying to join a channel nobody can speak in.
        channel_types: ['voice'],
      },
    ],
  },
  {
    name: 'skip',
    description: 'Skip whatever is playing',
  },
  {
    name: 'queue',
    description: 'See what is playing and what is next',
  },
  {
    name: 'stop',
    description: 'Stop the music and leave the channel',
  },
  {
    name: 'about',
    description: 'Where the music comes from, and where this bot comes from',
  },
];

/**
 * Turn an interaction into an answer.
 *
 * `ctx` carries the community, the session for this channel and the ways of speaking;
 * `sessions` is the bot's map of live sessions, handed in rather than imported so the
 * tests can hold their own.
 */
async function handle(interaction, ctx) {
  const options = interaction.options || {};
  switch (interaction.command) {
    case 'play':
      await runPlay(options, ctx);
      return null;
    case 'skip':
      return runSkip(ctx);
    case 'queue':
      return runQueue(ctx);
    case 'stop':
      return runStop(ctx);
    case 'about':
      return runAbout();
    default:
      return { type: 'ephemeral', content: 'I do not know that command.' };
  }
}

/**
 * Find something and queue it.
 *
 * Deferred first. Searching is a round trip to Openverse and joining a room is several
 * more, and the interaction window is ten seconds: without the defer the spinner gives up
 * while the bot is still doing exactly what it was asked.
 */
async function runPlay(options, ctx) {
  const query = (options.query || '').trim();
  const channelId = options.channel;
  await tell(ctx, ctx.defer({ ephemeral: true }));

  let results;
  try {
    results = await ctx.search(query);
  } catch (err) {
    ctx.log(`search failed: ${err.message}`);
    await tell(ctx, ctx.update(`I could not reach the music search just now: ${err.message}`));
    return;
  }

  if (results.length === 0) {
    await tell(ctx, ctx.update(
      `Nothing openly licensed came back for "${query}".\n\n` +
      'Everything this bot can play is Creative Commons, so the catalogue is not the ' +
      'chart: try a genre or a mood rather than an artist.',
    ));
    return;
  }

  const track = results[0];
  let position;
  try {
    const session = ctx.sessionFor(channelId);
    position = await session.enqueue(track, ctx.userId);
  } catch (err) {
    await tell(ctx, ctx.update(`I could not queue that: ${err.message}`));
    return;
  }

  const where = position <= 1 ? 'Playing now' : `Queued, number ${position}`;
  await tell(ctx, ctx.update(
    `${where}: ${credit(track)}` +
    (track.durationMs ? ` (${clock(track.durationMs)})` : '') +
    (track.pageUrl ? `\n${track.pageUrl}` : ''),
  ));
}

/**
 * The line posted in the channel as a track starts.
 *
 * In the channel rather than ephemerally on purpose: this is the credit the licence asks
 * for, and credit nobody but the requester can see is not credit. It also means somebody
 * who wanders in halfway through can see what they are listening to.
 */
function nowPlayingLine(entry) {
  const { track } = entry;
  const parts = [`Now playing: ${credit(track)}`];
  if (track.licenceUrl) parts.push(track.licenceUrl);
  else if (track.pageUrl) parts.push(track.pageUrl);
  return parts.join('\n');
}

function runSkip(ctx) {
  const session = ctx.liveSession();
  if (!session || !session.queue.current) {
    return { type: 'ephemeral', content: 'Nothing is playing.' };
  }
  const skipped = session.skip();
  return {
    type: 'message',
    content: `Skipped ${skipped.track.title}.`,
  };
}

function runQueue(ctx) {
  const session = ctx.liveSession();
  const entries = session ? session.queue.list() : [];
  if (entries.length === 0) {
    return { type: 'ephemeral', content: 'Nothing is playing and nothing is queued.' };
  }

  const lines = entries.map((entry, i) => {
    const length = entry.track.durationMs ? ` (${clock(entry.track.durationMs)})` : '';
    const prefix = i === 0 ? 'Playing' : `${i}.`;
    return `${prefix} ${credit(entry.track)}${length}`;
  });

  const total = totalDuration(entries);
  if (total !== null) lines.push(`\n${clock(total)} in all.`);
  return { type: 'ephemeral', content: lines.join('\n') };
}

async function runStop(ctx) {
  const session = ctx.liveSession();
  if (!session) return { type: 'ephemeral', content: 'Nothing is playing.' };
  await session.stop();
  return { type: 'message', content: 'Stopped.' };
}

function runAbout() {
  return {
    type: 'ephemeral',
    content:
      'I play openly licensed music from Openverse, which indexes Jamendo, Freesound, ' +
      'ccMixter and Wikimedia. Everything I play is Creative Commons, which is why I ' +
      'name the track and its licence every time.\n\n' +
      `I am an example bot and you can read, fork and run me: ${REPO}`,
  };
}

/**
 * Say something, and carry on if saying it fails.
 *
 * Talking about the work is not the work. An interaction may have expired while a track
 * was being found, and that is not a reason to abandon the music.
 */
async function tell(ctx, promise) {
  try {
    return await promise;
  } catch (err) {
    ctx.log(`could not say anything: ${err.message}`);
    return null;
  }
}

export { definitions, handle, nowPlayingLine, runPlay, runSkip, runQueue, runStop, runAbout, REPO };
