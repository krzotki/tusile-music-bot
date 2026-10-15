import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { Session } from './player.js';
import { FRAME_BYTES } from './decode.js';

/**
 * A community, a room and an ffmpeg, all fake.
 *
 * The session is the piece where the interesting mistakes are about lifetime rather than
 * audio: who hangs up, when, and what happens to the queue when something fails halfway.
 * None of that needs a real room, and all of it needs to be checked.
 */
function harness({ frames = 5, exitCode = 0 } = {}) {
  const published = [];
  const events = [];
  const room = {
    // Paced, like the real one. captureFrame returns when the source is ready for the next
    // 10 ms, which makes it the clock as well as the transport: a fake that resolves
    // immediately drains a whole track in microtasks and nothing can be observed mid play.
    publish: (s) => new Promise((r) => { published.push(s); setImmediate(r); }),
    drain: async () => events.push('drain'),
    close: async () => events.push('close'),
  };
  const server = {
    joinVoice: async (c) => events.push(`join:${c}`),
    voiceToken: async () => ({ url: 'wss://x', token: 't' }),
    setVoiceState: async (c, s) => events.push(`speaking:${s.speaking}`),
    leaveVoice: async (c) => events.push(`leave:${c}`),
    send: async () => {},
  };
  const spawnImpl = () => ({
    stdout: Readable.from([Buffer.alloc(FRAME_BYTES * frames)]),
    stderr: Readable.from([]),
    exitCode,
    kill: () => {},
  });
  const session = new Session({
    server,
    channelId: 'v1',
    log: (l) => events.push(`log:${l}`),
    connect: async () => { events.push('connect'); return room; },
    spawn: spawnImpl,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => ({ status: 200, headers: { get: () => null } }),
    sleep: async () => {},
  });
  return { session, published, events };
}

const track = (title = 'one') => ({ title, url: `https://example.com/${title}.mp3` });

/** Wait for the pump to finish, which enqueue deliberately does not do. */
async function settle(session) {
  for (let i = 0; i < 20000 && (session.running || session.queue.size > 0); i++) {
    await new Promise((r) => setImmediate(r));
  }
}

test('a queued track is joined, published and then left', async () => {
  const { session, published, events } = harness({ frames: 3 });
  await session.enqueue(track(), 'u1');
  await settle(session);

  assert.equal(published.length, 3);
  assert.ok(events.includes('join:v1'));
  assert.ok(events.includes('connect'));
  assert.ok(events.includes('leave:v1'));
});

/**
 * A bot left standing in a channel with a live microphone, playing nothing, is the failure
 * people report as "the bot is broken". It has to be impossible, including on the way out
 * of an error.
 */
test('the microphone is put down even when the room never opened', async () => {
  const { session, events } = harness();
  session.connect = async () => { throw new Error('room refused'); };
  await session.enqueue(track(), 'u1');
  await settle(session);

  assert.ok(events.includes('speaking:false'), 'it still claims to be speaking');
  assert.ok(events.includes('leave:v1'), 'it is still in the channel');
});

test('two tracks play one after the other without rejoining', async () => {
  const { session, published, events } = harness({ frames: 2 });
  await session.enqueue(track('one'), 'u1');
  await session.enqueue(track('two'), 'u1');
  await settle(session);

  assert.equal(published.length, 4);
  assert.equal(events.filter((e) => e === 'connect').length, 1);
});

/**
 * One bad track must not end the evening. A dead link, a format ffmpeg cannot read, a 403
 * from a CDN: the queue moves on.
 */
test('a track that will not play does not take the queue down with it', async () => {
  const { session, published, events } = harness({ frames: 2 });
  let first = true;
  const good = session.spawn;
  session.spawn = (...args) => {
    if (first) { first = false; throw new Error('ffmpeg is not installed'); }
    return good(...args);
  };

  await session.enqueue(track('bad'), 'u1');
  await session.enqueue(track('good'), 'u1');
  await settle(session);

  assert.equal(published.length, 2, 'the second track never played');
  assert.ok(events.some((e) => e.startsWith('log:could not play bad')));
});

test('skipping stops the current track and starts the next', async () => {
  const { session, published } = harness({ frames: 50 });
  await session.enqueue(track('one'), 'u1');
  await session.enqueue(track('two'), 'u1');

  // Let it get going, then skip mid track.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  const was = session.skip();
  await settle(session);

  assert.equal(was.track.title, 'one');
  assert.ok(published.length < 100, 'it played both tracks in full');
  assert.equal(session.queue.size, 0);
});

test('stopping empties the queue and hangs up', async () => {
  const { session, events } = harness({ frames: 50 });
  await session.enqueue(track('one'), 'u1');
  await session.enqueue(track('two'), 'u1');
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  await session.stop();
  await settle(session);

  assert.equal(session.queue.size, 0);
  assert.ok(events.includes('leave:v1'));
});

/**
 * `stopped` is permanent on purpose. A stop still tearing the room down must not be handed
 * a new track and resurrect itself halfway through hanging up.
 */
test('a stopped session refuses new tracks rather than reviving', async () => {
  const { session } = harness();
  await session.stop();
  await assert.rejects(() => session.enqueue(track(), 'u1'), /ended/);
});

/**
 * The twenty minute limit in search.js is read off the index's own metadata, and a row
 * with no duration is kept on purpose because most of the CC0 catalogue has none. So the
 * cap is advisory: a twelve hour stream with no duration field walks straight past it.
 *
 * This is the one that is not advisory. It counts frames actually played, which no
 * metadata can lie about.
 */
test('a track that runs forever is cut off rather than owning the channel', async () => {
  const { session, published } = harness({ frames: 10 });
  session.maxFrames = 4;
  await session.enqueue(track(), 'u1');
  await settle(session);

  assert.equal(published.length, 4, 'it played past its own limit');
});

test('and the queue moves on to the next track after cutting one off', async () => {
  const { session, published } = harness({ frames: 10 });
  session.maxFrames = 3;
  await session.enqueue(track('one'), 'u1');
  await session.enqueue(track('two'), 'u1');
  await settle(session);

  assert.equal(published.length, 6);
});

test('each track is announced as it starts', async () => {
  const { session } = harness({ frames: 1 });
  const announced = [];
  session.announce = async (entry) => { announced.push(entry.track.title); };

  await session.enqueue(track('one'), 'u1');
  await session.enqueue(track('two'), 'u1');
  await settle(session);

  assert.deepEqual(announced, ['one', 'two']);
});

/**
 * The channel may have been deleted, or the bot may have lost permission to post in it.
 * Neither stops the people in the voice channel hearing the track.
 */
test('a failure to announce does not stop the music', async () => {
  const { session, published } = harness({ frames: 2 });
  session.announce = async () => { throw new Error('no permission'); };

  await session.enqueue(track(), 'u1');
  await settle(session);
  assert.equal(published.length, 2);
});

// There is exactly one pump, and enqueue is the only thing that starts it. Two would feed
// the same room from two loops, which is heard as both tracks at once.
test('a second track does not start a second pump', async () => {
  const { session, events } = harness({ frames: 1 });
  await session.enqueue(track('one'), 'u1');
  await session.enqueue(track('two'), 'u1');
  await settle(session);
  assert.equal(events.filter((e) => e === 'connect').length, 1);
});

// captureFrame returns when a frame is queued in the source, not when it has left the
// machine. Hanging up without waiting throws away whatever is still queued.
test('queued audio is drained before hanging up', async () => {
  const { session, events } = harness({ frames: 1 });
  await session.enqueue(track(), 'u1');
  await settle(session);
  assert.ok(events.indexOf('drain') < events.indexOf('close'));
});
