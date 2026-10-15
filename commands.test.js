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
  };
  return {
    said,
    queued,
    session: fake,
    ctx: {
      userId: 'u-1',
      channelId: 'c-1',
      log: () => {},
      search: async (q) => {
        if (searchThrows) throw new Error(searchThrows);
        said.push({ searched: q });
        return results;
      },
      defer: async () => said.push({ defer: true }),
      update: async (content) => said.push({ update: content }),
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
  assert.match(line, /creativecommons\.org/);
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
