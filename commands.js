/**
 * The four things you can ask this bot to do.
 *
 * Every answer that names a track names its licence too. These are Creative Commons
 * recordings and all but the CC0 ones require credit wherever they are used, so the credit
 * is part of playing them rather than something the README asks you to remember.
 */

import { search, credit, pageSizeFor } from './search.js';
import { nextSeed, pickPage, stationChoices, SEEDS } from './radio.js';
import { clock, totalDuration } from './queue.js';

/**
 * How this bot says a track has started, in both places it says it.
 *
 * One phrase, because there are two lines about the same event: the answer to whoever ran
 * the command, and the line in the channel. They read "Playing now" and "Now playing",
 * which is two different things happening as far as anybody skimming is concerned.
 */
const PLAYING = 'Now playing';

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
        // Optional. Without it this is a radio: a shuffle over the same catalogue that
        // keeps itself topped up, for when you want music on and have nothing in mind.
        description: 'What to look for. Leave it empty for a radio.',
      },
      {
        name: 'channel',
        type: 'channel',
        // Optional, and almost never given. The answer was always "the one I am in", so
        // the interaction's own answer to that is the default and this is for the rarer
        // case of queueing into a room you are about to walk into.
        description: 'Which voice channel, if not the one you are in',
        // Without this the picker offers text channels too, and choosing one gets as far
        // as the bot trying to join a channel nobody can speak in.
        channel_types: ['voice'],
      },
    ],
  },
  {
    name: 'radio',
    description: 'Put a station on and leave it playing',
    options: [
      {
        name: 'station',
        type: 'string',
        description: 'Which station',
        // Required, which is the opposite of what it looks like it should be.
        //
        // The client opens its option form only for a command that cannot run without
        // being asked. An optional station would therefore never be offered: /radio would
        // run on the spot with no station, which is what /play already does. Required is
        // what makes the dropdown appear, and the dropdown is the whole feature.
        required: true,
        choices: stationChoices(),
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
    // Null when they answered over their own defer; a refusal before it comes back here.
    case 'play':
      return (await runPlay(options, ctx)) ?? null;
    case 'radio':
      return (await runRadio(options, ctx)) ?? null;
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
  // Where they are, unless they said otherwise. A channel somebody is sitting in is also
  // the one channel id a bot never has to wonder about: naming one you may not enter is
  // what the server's channel option check exists for, and this sidesteps the question.
  const channelId = options.channel || ctx.userVoiceChannelId;

  // A mistake is answered to the one who made it, before the defer: the defer is what
  // decides who an answer is for, and it cannot be taken back. Music starting in a room is
  // the room's business, so everything after it is said to the channel, the way /stop is.
  if (!channelId) {
    return {
      type: 'ephemeral',
      content:
        'Join a voice channel first and I will play there, or name one with the channel ' +
        'option.',
    };
  }
  await tell(ctx, ctx.defer({ ephemeral: false }));

  if (!query) {
    await startRadio(ctx, channelId);
    return;
  }

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
    // This answer says "Now playing" itself when the track starts at once.
    position = await session.enqueue(track, ctx.userId, { announced: true });
  } catch (err) {
    await tell(ctx, ctx.update(`I could not queue that: ${err.message}`));
    return;
  }

  const where = position <= 1 ? PLAYING : `Queued, number ${position}`;
  await tell(ctx, ctx.update(
    `${where}: ${credit(track)}` +
    (track.durationMs ? ` (${clock(track.durationMs)})` : '') +
    (track.pageUrl ? `\n${track.pageUrl}` : ''),
  ));
}

/**
 * Put one station on.
 *
 * /play with nothing to say shuffles across every station, which is the right default and
 * the wrong answer to "put some jazz on". This is that answer.
 *
 * The station is checked against the list rather than passed through. The client only ever
 * sends one of the choices, so a value that is not among them came from somewhere else,
 * and searching for it would turn a station into a free text search that happens to be
 * spelled like one.
 */
async function runRadio(options, ctx) {
  const station = String(options.station || '').trim().toLowerCase();
  // The caller's own room only: /radio declares no channel option, so one sent anyway
  // never met the server's view + Connect check that /play's declared option gets.
  const channelId = ctx.userVoiceChannelId;

  // Refusals first and privately, then the defer, public: see runPlay.
  if (!channelId) {
    return { type: 'ephemeral', content: 'Join a voice channel first and I will play there.' };
  }
  if (!SEEDS.includes(station)) {
    return {
      type: 'ephemeral',
      content: `I do not have a station called "${options.station}". Choose one from the list.`,
    };
  }
  await tell(ctx, ctx.defer({ ephemeral: false }));

  await startRadio(ctx, channelId, { station });
}

/**
 * Turn the radio on in a channel.
 *
 * The session keeps itself going by calling back here, so the shuffle lives with the
 * command rather than in the player: the player's job is to feed a room, and what to feed
 * it is this file's business.
 *
 * Each refill is a different genre from the one before and a different page of its
 * results, because Openverse has no "random" and the first page of ten queries is the same
 * forty tracks every evening.
 */
async function startRadio(ctx, channelId, { station = null } = {}) {
  // A station stays put; the mixed radio moves on each time.
  let seed = station;
  let session;
  try {
    session = ctx.sessionFor(channelId);
  } catch (err) {
    await tell(ctx, ctx.update(`I could not start: ${err.message}`));
    return;
  }

  // Returns whether it found anything. The player ends the session on false rather than
  // spinning on an empty queue with a room still open.
  // Whether anything has been queued yet. The first batch is the one somebody is waiting
  // on, and it is allowed to be less adventurous than the rest.
  let started = false;

  session.refill = async () => {
    if (!station) seed = nextSeed(seed);

    // The batch somebody is waiting on, out of the pocket.
    //
    // Measured cold: thirty seven seconds from /radio to the first sound, nearly all of it
    // this one search. The stations are known at startup, so the first batch does not have
    // to be fetched while a person sits in an empty voice channel.
    if (!started && ctx.stations) {
      const warm = await ctx.stations.take(seed).catch(() => []);
      if (warm.length > 0) {
        for (const t of warm.slice(0, RADIO_BATCH)) {
          try {
            session.queue.add(t, 'radio');
          } catch {
            break;
          }
        }
        started = true;
        return true;
      }
    }

    // One call that does both jobs: a batch to play, and the total to pick a page from.
    const first = await ctx.search(seed, { limit: RADIO_BATCH, withTotal: true });
    const total = first?.total ?? 0;
    // The size of a page as the request will actually ask for it, not one row per page.
    const page = pickPage(total, pageSizeFor(RADIO_BATCH));
    // Page one, for the batch somebody is waiting on.
    //
    // Measured: nineteen seconds from /radio to the first sound, fifteen of them gone
    // before the bot had joined the room, because a refill made two Openverse calls and
    // an anonymous one takes the better part of eight seconds. The second call buys
    // variety, and the first batch does not need variety: page one is already in hand and
    // five tracks is a quarter of an hour. The wandering starts from the refill after it.
    const wander = started && page > 1;
    const found = wander
      ? await ctx.search(seed, { limit: RADIO_BATCH, page })
      : (first?.tracks ?? []);
    if (found.length === 0) return false;
    for (const track of found.slice(0, RADIO_BATCH)) {
      // Queued as the radio rather than as a person, so it is never refused for being
      // over somebody's limit.
      try {
        session.queue.add(track, 'radio');
      } catch {
        started = true;
        return true;
      }
    }
    started = true;
    return true;
  };
  session.radio = true;

  try {
    if (!(await session.refill())) {
      await tell(ctx, ctx.update('I could not find anything to play just now.'));
      return;
    }
    await session.enqueue(session.queue.waiting.shift().track, ctx.userId);
  } catch (err) {
    await tell(ctx, ctx.update(`I could not start the radio: ${err.message}`));
    return;
  }

  await tell(ctx, ctx.update(
    `${station ? `${station[0].toUpperCase()}${station.slice(1)} radio on.` : 'Radio on.'} ` +
    'I will keep openly licensed music playing and name each track as it starts. ' +
    '/skip for the next one, /stop to end it.',
  ));
}

/** How many tracks a refill queues at a time. Enough to not ask again every three minutes. */
const RADIO_BATCH = 5;

/**
 * The line posted in the channel as a track starts.
 *
 * In the channel rather than ephemerally on purpose: this is the credit the licence asks
 * for, and credit nobody but the requester can see is not credit. It also means somebody
 * who wanders in halfway through can see what they are listening to.
 */
function nowPlayingLine(entry) {
  const { track } = entry;
  const parts = [`${PLAYING}: ${credit(track)}`];
  // The track's own page, not the text of its licence. The licence is named in words one
  // line above and nobody wants to read its deed; the page is where the music, the artist
  // and the attribution are. This linked the deed while the ephemeral answer linked the
  // page, so one track arrived twice pointing at two different places.
  if (track.pageUrl) parts.push(track.pageUrl);
  else if (track.licenceUrl) parts.push(track.licenceUrl);
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

export { definitions, handle, nowPlayingLine, runPlay, runRadio, runSkip, runQueue, runStop, runAbout, REPO, PLAYING };
