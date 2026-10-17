import test from 'node:test';
import assert from 'node:assert/strict';

import { definitions, handle, nowPlayingLine, REPO } from './commands.js';
import { Queue } from './queue.js';

const track = (over = {}) => ({
  title: 'Keep me Alive',
  artist: 'JekK',
  url: 'https://example.com/a.mp3',
  durationMs: 164000,
  licence: 'BY-NC-ND',
  licenceUrl: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
  pageUrl: 'https://www.jamendo.com/track/1968662',
  source: 'jamendo',
  ...over,
});

/** A context, with a session that records rather than plays. */
function ctxWith({ results = [track()], session = null, searchThrows = null } = {}) {
  const said = [];
  const queued = [];
  const fake = session ?? {
    queue: new Queue(),
    enqueue: async (t, by) => { queued.push({ t, by }); return queued.length; },
    skip() { return this.queue.current; },
    stop: async () => said.push({ stopped: true }),
    stopped: false,
    radio: false,
    refill: null,
  };
  return {
    said,
    queued,
    session: fake,
    ctx: {
      userId: 'u-1',
      channelId: 'c-1',
      log: () => {},
      // Honours withTotal, like the real one: a fake that always returns an array made
      // the radio look like it had found nothing.
      search: async (q, opts = {}) => {
        if (searchThrows) throw new Error(searchThrows);
        said.push({ searched: q, opts });
        return opts.withTotal ? { tracks: results, total: results.length * 40 } : results;
      },
      defer: async (opts = {}) => said.push({ defer: true, ephemeral: opts.ephemeral === true }),
      update: async (content) => said.push({ update: content }),
      // An empty pocket by default: these tests are about the search path, and a warmed
      // cache would skip it entirely.
      stations: { take: async () => [] },
      sessionFor: () => fake,
      liveSession: () => fake,
      server: { send: async () => {} },
    },
  };
}

test('play searches, queues, and says what it queued', async () => {
  const { ctx, said, queued } = ctxWith();
  const res = await handle({ command: 'play', options: { query: 'lofi', channel: 'v1' } }, ctx);

  assert.equal(res, null, 'play answers over its own deferred interaction');
  assert.ok(said.some((s) => s.defer), 'it did not defer');
  assert.equal(queued.length, 1);
  const answer = said.find((s) => s.update).update;
  assert.match(answer, /Keep me Alive/);
  assert.match(answer, /JekK/);
});

/**
 * Searching is a round trip and joining a room is several more, against an interaction
 * window of ten seconds. Without the defer the spinner gives up while the bot is doing
 * exactly what it was asked.
 */
test('play defers before it does anything slow', async () => {
  const { ctx, said } = ctxWith();
  await handle({ command: 'play', options: { query: 'lofi', channel: 'v1' } }, ctx);
  assert.ok(said[0].defer, `first thing it did was ${JSON.stringify(said[0])}`);
});

/**
 * Every licence here except CC0 requires credit wherever the work is used. This is the
 * one thing in this example that would be wrong to copy without.
 */
test('every answer naming a track names its licence', async () => {
  const { ctx, said } = ctxWith();
  await handle({ command: 'play', options: { query: 'lofi', channel: 'v1' } }, ctx);
  assert.match(said.find((s) => s.update).update, /BY-NC-ND/);
});

test('and so does the line posted when it starts playing', () => {
  const line = nowPlayingLine({ track: track() });
  assert.match(line, /Keep me Alive/);
  assert.match(line, /JekK/);
  assert.match(line, /BY-NC-ND/);
  // The track's page, not the licence deed: see the test below that pins which of the two
  // this links and why.
  assert.match(line, /jamendo\.com/);
});

/**
 * The catalogue is openly licensed music, not the charts. Somebody searching for a song
 * they know gets nothing, and "no results" alone reads as the bot being broken.
 */
test('nothing found says why, not just that', async () => {
  const { ctx, said } = ctxWith({ results: [] });
  await handle({ command: 'play', options: { query: 'taylor swift', channel: 'v1' } }, ctx);

  const answer = said.find((s) => s.update).update;
  assert.match(answer, /Creative Commons|openly licensed/i);
  assert.match(answer, /genre|mood/i, 'it does not say what would work instead');
});

test('a search that failed is not reported as no results', async () => {
  const { ctx, said } = ctxWith({ searchThrows: 'openverse is down' });
  await handle({ command: 'play', options: { query: 'lofi', channel: 'v1' } }, ctx);
  assert.match(said.find((s) => s.update).update, /could not reach/i);
});

test('being over your queue limit is explained, not swallowed', async () => {
  const session = {
    queue: new Queue(),
    enqueue: async () => { throw new Error('you already have 5 tracks waiting'); },
    stopped: false,
  };
  const { ctx, said } = ctxWith({ session });
  await handle({ command: 'play', options: { query: 'lofi', channel: 'v1' } }, ctx);
  assert.match(said.find((s) => s.update).update, /5 tracks waiting/);
});

test('skip with nothing playing says so rather than skipping nothing', async () => {
  const { ctx } = ctxWith();
  const res = await handle({ command: 'skip', options: {} }, ctx);
  assert.equal(res.type, 'ephemeral');
  assert.match(res.content, /Nothing is playing/);
});

test('skip names what it skipped', async () => {
  const { ctx, session } = ctxWith();
  session.queue.add(track(), 'u-1');
  session.queue.next();
  const res = await handle({ command: 'skip', options: {} }, ctx);
  assert.match(res.content, /Keep me Alive/);
});

test('the queue lists what is playing first, then what is next', async () => {
  const { ctx, session } = ctxWith();
  session.queue.add(track({ title: 'one' }), 'u-1');
  session.queue.add(track({ title: 'two' }), 'u-1');
  session.queue.next();

  const res = await handle({ command: 'queue', options: {} }, ctx);
  assert.match(res.content, /Playing one/);
  assert.match(res.content, /1\. two/);
  assert.equal(res.type, 'ephemeral', 'a queue listing is for whoever asked');
});

test('an empty queue says both things are empty', async () => {
  const { ctx } = ctxWith();
  const res = await handle({ command: 'queue', options: {} }, ctx);
  assert.match(res.content, /Nothing is playing/);
});

test('stop stops', async () => {
  const { ctx, said } = ctxWith();
  const res = await handle({ command: 'stop', options: {} }, ctx);
  assert.ok(said.some((s) => s.stopped));
  assert.match(res.content, /Stopped/);
});

// An example nobody can find the source of is not an example.
test('about says where the music and the bot come from', async () => {
  const { ctx } = ctxWith();
  const res = await handle({ command: 'about', options: {} }, ctx);
  assert.match(res.content, /Openverse/);
  assert.match(res.content, /Creative Commons/);
  assert.ok(res.content.includes(REPO), 'no repository link');
});

test('the repository link is a real github url', () => {
  assert.match(REPO, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
});

// The picker offers text channels too without this, and choosing one gets as far as the
// bot trying to join a channel nobody can speak in.
test('play only offers voice channels', () => {
  const play = definitions.find((d) => d.name === 'play');
  const channel = play.options.find((o) => o.name === 'channel');
  assert.deepEqual(channel.channel_types, ['voice']);
});

test('every command has a description somebody could act on', () => {
  for (const d of definitions) {
    assert.ok(d.description && d.description.length > 10, `/${d.name}: ${d.description}`);
  }
});

/**
 * The two lines said different things and linked different places.
 *
 * Reported with a screenshot of both at once: the channel line ended at
 * creativecommons.org/publicdomain/zero/1.0/, which is the text of the licence, and the
 * ephemeral one at the track's page on Freesound. The licence is already named in words a
 * line above; nobody wants to read its deed. The page is where the music, the artist and
 * the attribution are.
 */
test('the channel line links the track, not the text of its licence', () => {
  const line = nowPlayingLine({ track: track() });
  assert.match(line, /jamendo\.com\/track\/1968662/);
  assert.doesNotMatch(line, /creativecommons\.org/, 'it links the licence deed');
});

test('and falls back to the licence only when there is no track page', () => {
  const line = nowPlayingLine({ track: track({ pageUrl: null }) });
  assert.match(line, /creativecommons\.org/);
});

// Two lines about the same event, worded two ways, read as two different things happening.
test('both lines say the same thing about the same track', async () => {
  const { ctx, said } = ctxWith();
  await handle({ command: 'play', options: { query: 'lofi', channel: 'v1' } }, ctx);
  const ephemeral = said.find((s) => s.update).update;
  const channel = nowPlayingLine({ track: track() });

  const lead = (s) => s.split(':')[0].trim();
  assert.equal(lead(channel), lead(ephemeral),
    `channel says "${lead(channel)}", the answer says "${lead(ephemeral)}"`);
});

/**
 * Where to play, without being asked.
 *
 * The channel was a required argument in front of the only thing the command is for, and
 * the answer was always "the one I am in": nobody runs /play meaning a room they are not
 * sitting in. The interaction carries the caller's voice channel now, so the argument is
 * optional and the default is the obvious one.
 *
 * It is also the safer channel. An id somebody types is an id they may have no business
 * naming, which is the whole reason the server checks channel options; a channel they are
 * demonstrably sitting in needs no such question.
 */
test('play uses the voice channel the caller is in', async () => {
  const { ctx, queued } = ctxWith();
  ctx.userVoiceChannelId = 'v-where-they-are';
  let askedFor = null;
  ctx.sessionFor = (id) => { askedFor = id; return ctx.liveSession(); };

  await handle({ command: 'play', options: { query: 'lofi' } }, ctx);
  assert.equal(askedFor, 'v-where-they-are');
  assert.equal(queued.length, 1);
});

// Naming one explicitly still works, and wins. Somebody queueing for a room they are about
// to walk into is a real thing, and the server checks that they may name it.
test('and an explicit channel still wins', async () => {
  const { ctx } = ctxWith();
  ctx.userVoiceChannelId = 'v-where-they-are';
  let askedFor = null;
  ctx.sessionFor = (id) => { askedFor = id; return ctx.liveSession(); };

  await handle({ command: 'play', options: { query: 'lofi', channel: 'v-named' } }, ctx);
  assert.equal(askedFor, 'v-named');
});

test('and somebody in no voice channel is told to join one', async () => {
  const { ctx, said, queued } = ctxWith();
  ctx.userVoiceChannelId = '';

  const res = await handle({ command: 'play', options: { query: 'lofi' } }, ctx);
  assert.equal(res?.type, 'ephemeral', 'a mistake is told to the one who made it');
  assert.match(res.content, /voice channel/i);
  assert.equal(queued.length, 0, 'it queued a track with nowhere to play it');
});

test('the channel argument is not required any more', () => {
  const play = definitions.find((d) => d.name === 'play');
  const channel = play.options.find((o) => o.name === 'channel');
  assert.notEqual(channel.required, true);
});

/**
 * /play with no query at all.
 *
 * Asked for: there should be a way to just have music on without thinking of something to
 * search for. It is a shuffle over the same openly licensed catalogue that keeps itself
 * topped up, not a stream somebody else is programming, because that is what this bot has.
 */
test('play with no query starts the radio', async () => {
  const { ctx, session } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  await handle({ command: 'play', options: {} }, ctx);

  assert.equal(session.radio, true, 'it did not turn the radio on');
  assert.equal(typeof session.refill, 'function', 'it has no way to find more');
});

test('and says so, rather than naming one track as though that were all', async () => {
  const { ctx, said } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  await handle({ command: 'play', options: {} }, ctx);

  const answer = said.find((s) => s.update).update;
  assert.match(answer, /radio/i);
});

test('a query still queues exactly that and leaves the radio off', async () => {
  const { ctx, session, queued } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  await handle({ command: 'play', options: { query: 'lofi' } }, ctx);

  assert.equal(session.radio, false);
  assert.equal(queued.length, 1);
});

test('the query argument is not required any more', () => {
  const play = definitions.find((d) => d.name === 'play');
  const query = play.options.find((o) => o.name === 'query');
  assert.notEqual(query.required, true);
});

// The refill has to actually add something to the queue, not merely report success.
test('the radio refill puts tracks in the queue', async () => {
  const { ctx, session } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  await handle({ command: 'play', options: {} }, ctx);

  const added = await session.refill();
  assert.equal(added, true);
  assert.ok(session.queue.size > 0, 'it said it found some and queued none');
});

// Learning the total should not cost a round that queues one track. The first call asks
// for a batch and the total together.
test('a radio round that lands on page one still queues a batch', async () => {
  const many = Array.from({ length: 5 }, (_, i) => track({ title: `t${i}`, url: `https://x/${i}.mp3` }));
  const { ctx, session } = ctxWith({ results: many });
  ctx.userVoiceChannelId = 'v1';
  // Force page one by reporting a tiny catalogue.
  ctx.search = async (q, opts = {}) => (opts.withTotal ? { tracks: many, total: 5 } : many);

  await handle({ command: 'play', options: {} }, ctx);
  await session.refill();
  assert.ok(session.queue.size >= 5, `queued ${session.queue.size}`);
});

/**
 * /radio, and why its station is required.
 *
 * Asked for: a way to choose jazz, lofi, techno or rock rather than take the shuffle.
 *
 * The station is required on purpose, which is the opposite of what it looks like it
 * should be. The client opens its option form only for a command that cannot run without
 * being asked, so an optional station would never be offered at all: the command would run
 * on the spot with no station, which is /play's job already. Required is what makes the
 * dropdown appear, and the dropdown is the whole feature.
 */
test('radio asks for a station, and offers the list', () => {
  const radio = definitions.find((d) => d.name === 'radio');
  assert.ok(radio, '/radio is missing');
  const station = radio.options.find((o) => o.name === 'station');
  assert.ok(station, 'it takes no station');
  assert.equal(station.required, true,
    'an optional station is never asked for, so it can never be chosen');
  assert.ok(Array.isArray(station.choices) && station.choices.length >= 10);
});

test('and it plays that station rather than the shuffle', async () => {
  const { ctx, session } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  await handle({ command: 'radio', options: { station: 'jazz' } }, ctx);

  assert.equal(session.radio, true);
  const searched = [];
  ctx.search = async (q, opts = {}) => {
    searched.push(q);
    return opts.withTotal ? { tracks: [track()], total: 40 } : [track()];
  };
  await session.refill();
  await session.refill();
  assert.deepEqual([...new Set(searched)], ['jazz'], `it wandered: ${searched.join(', ')}`);
});

test('a station nobody offers is refused rather than searched for', async () => {
  const { ctx, said } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  const res = await handle({ command: 'radio', options: { station: 'the beatles' } }, ctx);
  const answer = res?.content ?? said.find((s) => s.update)?.update ?? '';
  assert.match(String(answer), /station|choose|pick/i);
});

test('radio needs a voice channel just as play does', async () => {
  const { ctx, said } = ctxWith();
  ctx.userVoiceChannelId = '';
  const res = await handle({ command: 'radio', options: { station: 'jazz' } }, ctx);
  assert.equal(res?.type, 'ephemeral');
  assert.match(res.content, /voice channel/i);
});

// The mixed shuffle stays where it was: /play with nothing to say.
test('play with no query is still the mixed radio', async () => {
  const { ctx, session } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  await handle({ command: 'play', options: {} }, ctx);
  assert.equal(session.radio, true);
});

/**
 * How long it takes before there is a sound.
 *
 * Measured: nineteen seconds from /radio to the first audio frame, and fifteen of them
 * were gone before the bot had even joined the room. Each refill made two Openverse
 * calls, one to learn the total and one for a random page in it, and an anonymous
 * Openverse call takes the better part of eight seconds.
 *
 * The first batch needs neither. Page one is already in hand from the call that learned
 * the total, and five tracks is a quarter of an hour of music: nobody is bored of page one
 * before the next refill comes round. The wandering is for the refills after it.
 */
test('the first batch plays what the first call already returned', async () => {
  const calls = [];
  const { ctx, session } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  ctx.search = async (q, opts = {}) => {
    calls.push(opts);
    const tracks = [track(), track({ title: 'b', url: 'https://x/b.mp3' })];
    return opts.withTotal ? { tracks, total: 400 } : tracks;
  };

  await handle({ command: 'radio', options: { station: 'jazz' } }, ctx);
  assert.equal(calls.length, 1, `it searched ${calls.length} times before playing anything`);
  assert.ok(session.queue.size > 0, 'it queued nothing');
});

// Later refills still wander, or the station is the same five tracks forever.
test('a later refill may ask for a different page', async () => {
  const pages = [];
  const { ctx, session } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  ctx.search = async (q, opts = {}) => {
    pages.push(opts.page ?? 1);
    const tracks = [track()];
    return opts.withTotal ? { tracks, total: 400 } : tracks;
  };

  await handle({ command: 'radio', options: { station: 'jazz' } }, ctx);
  for (let i = 0; i < 12; i++) await session.refill();
  assert.ok(pages.some((p) => p > 1), `every refill asked for page one: ${pages.join(',')}`);
});

// The pocket has to actually be used, or warming eighteen stations at startup buys
// nothing and no test would notice: every other test here stubs it empty on purpose.
test('the first batch comes from the warmed stations when there is one', async () => {
  let searched = 0;
  const { ctx, queued } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  ctx.search = async (q, opts = {}) => {
    searched += 1;
    return opts.withTotal ? { tracks: [track()], total: 40 } : [track()];
  };
  ctx.stations = {
    take: async (station) => {
      assert.equal(station, 'jazz', 'it asked the pocket for the wrong station');
      return [track({ title: 'from the pocket', url: 'https://x/p.mp3' })];
    },
  };

  await handle({ command: 'radio', options: { station: 'jazz' } }, ctx);
  assert.equal(searched, 0, 'it searched anyway');
  assert.equal(queued[0]?.t.title, 'from the pocket');
});

// And an empty pocket still plays: a station nobody warmed is slow, not broken.
test('an empty pocket falls through to the search', async () => {
  let searched = 0;
  const { ctx, queued } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  ctx.search = async (q, opts = {}) => {
    searched += 1;
    return opts.withTotal ? { tracks: [track()], total: 40 } : [track()];
  };
  ctx.stations = { take: async () => [] };

  await handle({ command: 'radio', options: { station: 'jazz' } }, ctx);
  assert.ok(searched > 0, 'it neither took nor searched');
  assert.ok(queued.length > 0, 'nothing reached the player');
});

// /radio declares no channel option, so the server never checked one: a channel smuggled
// into the options went past the view + Connect check that /play's declared option gets,
// and the bot would join a room the caller cannot enter. The caller's own room only.
test('radio plays only where the caller is, whatever the options say', async () => {
  const { ctx } = ctxWith();
  ctx.userVoiceChannelId = 'v-mine';
  const asked = [];
  const real = ctx.sessionFor;
  ctx.sessionFor = (id) => { asked.push(id); return real(id); };
  await handle({ command: 'radio', options: { station: 'jazz', channel: 'v-locked' } }, ctx);
  assert.deepEqual([...new Set(asked)], ['v-mine']);
});

// /radio answered "Rock radio on..." in a panel only the caller could see, while /stop
// answered "Stopped." in the channel under "DamnEdge used /stop". Music starting in a room
// is the room's business. The defer decides who the answer is for, so the checks that can
// refuse run first and stay private; what comes after the defer is said to everybody.
test('radio that starts says so to the channel', async () => {
  const { ctx, said } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  await handle({ command: 'radio', options: { station: 'jazz' } }, ctx);
  const d = said.find((s) => s.defer);
  assert.ok(d, 'it did not defer');
  assert.equal(d.ephemeral, false, 'the answer went to the caller only');
});

test('play that starts says so to the channel too', async () => {
  const { ctx, said } = ctxWith();
  await handle({ command: 'play', options: { query: 'lofi', channel: 'v1' } }, ctx);
  assert.equal(said.find((s) => s.defer)?.ephemeral, false);
});

test('a station nobody offers is refused privately, without a defer', async () => {
  const { ctx, said } = ctxWith();
  ctx.userVoiceChannelId = 'v1';
  const res = await handle({ command: 'radio', options: { station: 'the beatles' } }, ctx);
  assert.equal(res?.type, 'ephemeral');
  assert.equal(said.some((s) => s.defer), false);
});
