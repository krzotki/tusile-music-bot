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

/**
 * ffmpeg speaks far more than HTTP.
 *
 * `-i` accepts file:, concat:, data:, rtp: and a few dozen others, and the url handed to it
 * came from a third party search index describing files uploaded by strangers. Without a
 * whitelist, a result whose url is `file:///etc/passwd` is a bot that reads a file off the
 * host and plays it as noise into a voice channel, and `concat:` is the same trick with a
 * playlist. The startsWith('http') check in search.js is the first gate; this is the one
 * that holds when somebody changes that file.
 */
test('ffmpeg is allowed to speak http and nothing else', () => {
  const args = ffmpegArgs('https://example.com/a.mp3');
  const allowed = args[args.indexOf('-protocol_whitelist') + 1];
  assert.ok(allowed, 'no protocol whitelist at all');

  const protocols = allowed.split(',');
  assert.ok(protocols.includes('https'));
  for (const dangerous of ['file', 'concat', 'data', 'subfile', 'pipe']) {
    assert.ok(!protocols.includes(dangerous), `${dangerous} is allowed`);
  }
});

/**
 * A name that points inside.
 *
 * The address filter in search.js reads what is written in the url, so it catches
 * `http://10.0.0.5/` and cannot catch `http://files.attacker.example/` which resolves to
 * the same place. This is the lookup that closes the plain case, here rather than in
 * search.js because the README invites people to replace search.js and not this.
 *
 * It does not close DNS rebinding, and pretending otherwise would be worse than not having
 * it: ffmpeg resolves the name again when it connects, and nothing in this process can make
 * that answer the same one. A bot sitting on a network with reachable internal services
 * wants egress rules, which the README says.
 */
test('a hostname that resolves inside the network is refused', async () => {
  const lookup = async () => [{ address: '10.0.0.5', family: 4 }];
  const errors = [];
  const frames = [];
  for await (const f of decode('http://files.attacker.example/a.mp3', {
    spawn: () => { throw new Error('ffmpeg was started'); },
    lookup,
    fetchImpl: noRedirect,
    onError: (e) => errors.push(e.message),
  })) {
    frames.push(f);
  }
  assert.equal(frames.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /10\.0\.0\.5|not a public address/i);
});

test('a hostname that resolves to a public address is played', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const { child } = fakeChild([Buffer.alloc(FRAME_BYTES * 2)]);
  const frames = [];
  for await (const f of decode('https://cdn.freesound.org/a.mp3', {
    spawn: () => child,
    lookup,
    fetchImpl: noRedirect,
  })) {
    frames.push(f);
  }
  assert.equal(frames.length, 2);
});

// Several answers, one of them inside: refused. A name resolving to both is the shape of
// the attack, not an accident.
test('one private answer among several is enough to refuse', async () => {
  const lookup = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '169.254.169.254', family: 4 },
  ];
  const errors = [];
  for await (const _f of decode('http://x.example/a.mp3', {
    spawn: () => { throw new Error('ffmpeg was started'); },
    lookup,
    fetchImpl: noRedirect,
    onError: (e) => errors.push(e.message),
  })) { /* nothing should arrive */ }
  assert.equal(errors.length, 1);
});

test('the url is what ffmpeg reads, and nothing is downloaded first', () => {
  const args = ffmpegArgs('https://example.com/a.mp3');
  assert.equal(args[args.indexOf('-i') + 1], 'https://example.com/a.mp3');
});

/** Every answer public, so these tests never touch DNS. */
const outside = async () => [{ address: '93.184.216.34', family: 4 }];

/** A server that redirects nowhere, so no test here reaches the network. */
const noRedirect = async () => ({ status: 200, headers: { get: () => null } });

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
  for await (const f of decode(URL_OK, { spawn: () => child, lookup: outside,
    fetchImpl: noRedirect, fetchImpl: noRedirect })) frames.push(f);
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
  for await (const f of decode(URL_OK, { spawn: () => child, lookup: outside,
    fetchImpl: noRedirect, onError: (e) => errors.push(e) })) {
    frames.push(f);
  }
  assert.equal(frames.length, 0);
  assert.equal(errors.length, 1);
});

// Abandoning the generator is what /skip does. It must not leave an ffmpeg behind.
test('walking away from a track kills ffmpeg', async () => {
  const { child, killed } = fakeChild([Buffer.alloc(FRAME_BYTES * 10)], { exitCode: null });
  for await (const _f of decode(URL_OK, { spawn: () => child, lookup: outside,
    fetchImpl: noRedirect, fetchImpl: noRedirect })) break;
  assert.deepEqual(killed, ['SIGKILL']);
});

/**
 * The whole point of walking the redirects here: ffmpeg is handed where they ended.
 *
 * Handing it the original and telling it not to follow would simply not play the track,
 * and handing it the original while letting it follow is the hole this closes.
 */
test('ffmpeg is given the url the redirects ended at', async () => {
  let hop = 0;
  const fetchImpl = async () => {
    hop += 1;
    return hop === 1
      ? { status: 302, headers: { get: () => 'https://cdn2.example.com/real.mp3' } }
      : { status: 200, headers: { get: () => null } };
  };
  const { child } = fakeChild([Buffer.alloc(FRAME_BYTES)]);
  let given = null;
  for await (const _f of decode('https://cdn.example.com/a.mp3', {
    spawn: (_cmd, args) => { given = args[args.indexOf('-i') + 1]; return child; },
    lookup: outside,
    fetchImpl,
  })) { /* drain */ }
  assert.equal(given, 'https://cdn2.example.com/real.mp3');
});

test('ffmpeg is told to follow no redirects', () => {
  const args = ffmpegArgs('https://example.com/a.mp3');
  assert.equal(args[args.indexOf('-max_redirects') + 1], '0');
});

/**
 * That ffmpeg accepts the arguments at all.
 *
 * Every other test here reads the array this module builds, which cannot tell a real
 * ffmpeg option from an invented one. That is not hypothetical: this file shipped
 * `-follow_redirects 0`, which reads perfectly, is in plenty of documentation, and does
 * not exist in ffmpeg's command line. The unit test agreed with it and a live run found
 * it, with ffmpeg exiting on "Unrecognized option" before a single byte of audio.
 *
 * Points at a port nothing listens on, so this needs no network: the question is whether
 * ffmpeg parses the arguments, not whether it finds a track.
 */
test('and ffmpeg actually understands them', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const probe = spawnSync('ffmpeg', ['-hide_banner', '-version']);
  if (probe.error) return t.skip('ffmpeg is not installed here');

  const args = ffmpegArgs('http://93.184.216.34:1/nothing.mp3');
  const run = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 20000 });
  const said = `${run.stderr || ''}${run.stdout || ''}`;
  assert.doesNotMatch(said, /Unrecognized option|Option not found|Unknown option/i,
    `ffmpeg rejected the arguments: ${said.split('\n')[0]}`);
});
