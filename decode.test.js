import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { cutFrames, ffmpegArgs, decode, FRAME_BYTES, FRAME_SAMPLES } from './decode.js';

const URL_OK = 'https://cdn.freesound.org/previews/1/1.mp3';

test('whole frames come out and the remainder is carried', () => {
  const buffer = Buffer.alloc(FRAME_BYTES + 10);
  const { frames, rest } = cutFrames(buffer);

  assert.equal(frames.length, 1);
  assert.equal(frames[0].length, FRAME_SAMPLES);
  assert.equal(rest.length, 10);
});

test('less than a frame yields nothing and keeps everything', () => {
  const { frames, rest } = cutFrames(Buffer.alloc(FRAME_BYTES - 2));
  assert.equal(frames.length, 0);
  assert.equal(rest.length, FRAME_BYTES - 2);
});

/**
 * The bug this exists to stop: handing LiveKit a part frame is not a small error. Every
 * sample after it is read half a sample out, which is heard as tearing for the rest of the
 * track rather than as a click.
 */
test('samples survive the cut in order and with their sign', () => {
  const buffer = Buffer.alloc(FRAME_BYTES);
  buffer.writeInt16LE(-32768, 0);
  buffer.writeInt16LE(12345, 2);
  buffer.writeInt16LE(-1, FRAME_BYTES - 2);

  const { frames } = cutFrames(buffer);
  assert.equal(frames[0][0], -32768);
  assert.equal(frames[0][1], 12345);
  assert.equal(frames[0][FRAME_SAMPLES - 1], -1);
});

// A view into a pipe buffer is audio that changes after it has been handed over: LiveKit
// holds the frame past the call that gave it one.
test('a frame is a copy, not a window onto the pipe buffer', () => {
  const buffer = Buffer.alloc(FRAME_BYTES);
  buffer.writeInt16LE(999, 0);
  const { frames } = cutFrames(buffer);
  buffer.writeInt16LE(-999, 0);
  assert.equal(frames[0][0], 999);
});

test('ffmpeg is asked for exactly the format LiveKit takes', () => {
  const args = ffmpegArgs();
  const at = (flag) => args[args.indexOf(flag) + 1];

  assert.equal(at('-ar'), '48000');
  assert.equal(at('-ac'), '1');
  assert.equal(at('-f'), 's16le');
  assert.equal(args[args.length - 1], 'pipe:1');
});

// An MP3 with album art is a video stream as far as ffmpeg is concerned, and it will
// otherwise try to give us one.
test('album art is not treated as video to decode', () => {
  assert.ok(ffmpegArgs().includes('-vn'));
});

// Everybody uploads at a different level, and a CC0 field recording next to a mastered
// track is the difference between inaudible and painful.
test('everything is brought to roughly the same loudness', () => {
  const args = ffmpegArgs();
  assert.match(args[args.indexOf('-af') + 1], /loudnorm/);
});

/**
 * ffmpeg does no networking at all now.
 *
 * It used to fetch the url itself, which took a protocol whitelist to stop `-i file:`, a
 * redirect limit to stop a 302 into the private network, and a name resolution that ffmpeg
 * then repeated when it connected. That last repetition was DNS rebinding and could not be
 * closed from this side. stream.js opens the connection with the address pinned and hands
 * over the bytes; the only input here is a pipe, so none of those flags have anything left
 * to guard.
 */
test('ffmpeg reads a pipe, and is given no url at all', () => {
  const args = ffmpegArgs();
  assert.equal(args[args.indexOf('-i') + 1], 'pipe:0');
  for (const arg of args) {
    assert.doesNotMatch(String(arg), /^https?:/, `a url reached ffmpeg: ${arg}`);
  }
});

test('and needs none of the flags that used to hold its networking', () => {
  const args = ffmpegArgs().join(' ');
  for (const flag of ['-protocol_whitelist', '-max_redirects', '-reconnect']) {
    assert.ok(!args.includes(flag), `${flag} is still there, guarding nothing`);
  }
});

/**
 * That ffmpeg accepts the arguments at all.
 *
 * Every other test here reads the array this module builds, which cannot tell a real
 * ffmpeg option from an invented one. That is not hypothetical: this file shipped
 * `-follow_redirects 0`, which reads perfectly, is in plenty of documentation, and does
 * not exist in ffmpeg's command line. The unit test agreed with it and a live run found
 * it, with ffmpeg exiting on "Unrecognized option" before a single byte of audio.
 */
test('and ffmpeg actually understands them', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-version']);
  if (probe.error) return t.skip('ffmpeg is not installed here');

  const run = spawnSync('ffmpeg', ffmpegArgs(), { input: '', encoding: 'utf8', timeout: 20000 });
  const said = `${run.stderr || ''}${run.stdout || ''}`;
  assert.doesNotMatch(said, /Unrecognized option|Option not found|Unknown option/i,
    `ffmpeg rejected the arguments: ${said.split('\n')[0]}`);
});

/** A child process, as far as decode() is concerned. */
function fakeChild(chunks, { exitCode = 0 } = {}) {
  const killed = [];
  const written = [];
  return {
    killed,
    written,
    child: {
      stdout: Readable.from(chunks),
      stderr: Readable.from([]),
      stdin: Object.assign(Readable.from([]), {
        on() { return this; },
        write(c) { written.push(c); return true; },
        end() {},
      }),
      exitCode,
      kill: (sig) => killed.push(sig),
    },
  };
}

/** A body, as far as decode() is concerned. */
function fakeBody(bytes = Buffer.alloc(0)) {
  const stream = Readable.from([bytes]);
  stream.pipe = () => stream;
  stream.destroy = () => { stream.wasDestroyed = true; return stream; };
  return stream;
}

test('bytes split across two chunks still make whole frames', async () => {
  const half = Buffer.alloc(FRAME_BYTES / 2);
  const { child } = fakeChild([half, half, half, half]);
  const frames = [];
  for await (const f of decode(URL_OK, {
    spawn: () => child,
    openStream: async () => fakeBody(),
  })) frames.push(f);
  assert.equal(frames.length, 2);
});

/**
 * ffmpeg writing nothing at all is the interesting failure: a format it cannot read, or a
 * file that is not audio. Without noticing, the bot plays silence and reports that it
 * played the track, which is the most confusing thing a music bot can do.
 */
test('a track that produced no audio is reported, not played silently', async () => {
  const errors = [];
  const { child } = fakeChild([], { exitCode: 1 });
  const frames = [];
  for await (const f of decode(URL_OK, {
    spawn: () => child,
    openStream: async () => fakeBody(),
    onError: (e) => errors.push(e),
  })) frames.push(f);

  assert.equal(frames.length, 0);
  assert.equal(errors.length, 1);
});

// A dead link, a 403 from a CDN, a name that will not resolve: the reason comes from
// stream.js and has to reach the caller rather than looking like a silent track.
test('a body that could not be opened is reported and starts no ffmpeg', async () => {
  const errors = [];
  let started = false;
  const frames = [];
  for await (const f of decode(URL_OK, {
    spawn: () => { started = true; throw new Error('should not get here'); },
    openStream: async () => { throw new Error('cdn.example.com answered 403'); },
    onError: (e) => errors.push(e.message),
  })) frames.push(f);

  assert.equal(started, false);
  assert.deepEqual(errors, ['cdn.example.com answered 403']);
});

// Abandoning the generator is what /skip does. It must leave behind neither an ffmpeg nor
// a connection still downloading a track for nobody.
test('walking away from a track kills ffmpeg and closes the connection', async () => {
  const { child, killed } = fakeChild([Buffer.alloc(FRAME_BYTES * 10)], { exitCode: null });
  const body = fakeBody();
  for await (const _f of decode(URL_OK, { spawn: () => child, openStream: async () => body })) {
    break;
  }
  assert.deepEqual(killed, ['SIGKILL']);
  assert.equal(body.wasDestroyed, true, 'the connection was left open');
});

test('the body is piped into ffmpeg rather than buffered first', async () => {
  let pipedTo = null;
  const body = fakeBody();
  body.pipe = (dest) => { pipedTo = dest; return body; };
  const { child } = fakeChild([Buffer.alloc(FRAME_BYTES)]);

  for await (const _f of decode(URL_OK, { spawn: () => child, openStream: async () => body })) {
    /* drain */
  }
  assert.equal(pipedTo, child.stdin);
});
