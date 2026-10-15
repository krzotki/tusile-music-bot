import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { cutFrames, ffmpegArgs, decode, FRAME_BYTES, FRAME_SAMPLES } from './decode.js';

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
  const args = ffmpegArgs('https://example.com/a.mp3');
  const at = (flag) => args[args.indexOf(flag) + 1];

  assert.equal(at('-ar'), '48000');
  assert.equal(at('-ac'), '1');
  assert.equal(at('-f'), 's16le');
  assert.equal(args[args.length - 1], 'pipe:1');
});

// An MP3 with album art is a video stream as far as ffmpeg is concerned, and it will
// otherwise try to give us one.
test('album art is not treated as video to decode', () => {
  assert.ok(ffmpegArgs('https://example.com/a.mp3').includes('-vn'));
});

// These are plain HTTP urls on somebody else's CDN. A dropped connection a minute into a
// track used to end it.
test('a dropped connection is picked up rather than ending the track', () => {
  assert.ok(ffmpegArgs('https://example.com/a.mp3').includes('-reconnect'));
});

// Everybody uploads at a different level, and a CC0 field recording next to a mastered
// track is the difference between inaudible and painful.
test('everything is brought to roughly the same loudness', () => {
  const args = ffmpegArgs('https://example.com/a.mp3');
  assert.match(args[args.indexOf('-af') + 1], /loudnorm/);
});

test('the url is what ffmpeg reads, and nothing is downloaded first', () => {
  const args = ffmpegArgs('https://example.com/a.mp3');
  assert.equal(args[args.indexOf('-i') + 1], 'https://example.com/a.mp3');
});

/** A child process, as far as decode() is concerned. */
function fakeChild(chunks, { exitCode = 0 } = {}) {
  const killed = [];
  return {
    killed,
    child: {
      stdout: Readable.from(chunks),
      stderr: Readable.from([]),
      exitCode,
      kill: (sig) => killed.push(sig),
    },
  };
}

test('bytes split across two chunks still make whole frames', async () => {
  const half = Buffer.alloc(FRAME_BYTES / 2);
  const { child } = fakeChild([half, half, half, half]);
  const frames = [];
  for await (const f of decode('u', { spawn: () => child })) frames.push(f);
  assert.equal(frames.length, 2);
});

/**
 * ffmpeg writing nothing at all is the interesting failure: a dead link, a format it
 * cannot read, a 403 from a CDN. Without noticing, the bot plays silence and reports that
 * it played the track, which is the most confusing thing a music bot can do.
 */
test('a track that produced no audio is reported, not played silently', async () => {
  const errors = [];
  const { child } = fakeChild([], { exitCode: 1 });
  const frames = [];
  for await (const f of decode('u', { spawn: () => child, onError: (e) => errors.push(e) })) {
    frames.push(f);
  }
  assert.equal(frames.length, 0);
  assert.equal(errors.length, 1);
});

// Abandoning the generator is what /skip does. It must not leave an ffmpeg behind.
test('walking away from a track kills ffmpeg', async () => {
  const { child, killed } = fakeChild([Buffer.alloc(FRAME_BYTES * 10)], { exitCode: null });
  for await (const _f of decode('u', { spawn: () => child })) break;
  assert.deepEqual(killed, ['SIGKILL']);
});
