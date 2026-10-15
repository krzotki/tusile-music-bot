/**
 * Turning a file on the internet into something LiveKit will accept.
 *
 * LiveKit takes raw signed 16 bit samples at a fixed rate. The internet has MP3, OGG,
 * FLAC and WAV at whatever rate the person who uploaded it felt like. ffmpeg is the
 * translator, reading the url itself so nothing is ever downloaded to disk: a track starts
 * playing a second after the command, not after a five megabyte download.
 *
 * Splitting the arguments and the chunking out of the spawning is what makes this testable.
 * The two things that go wrong here are the wrong ffmpeg flags and a frame boundary off by
 * one sample, and neither needs a subprocess to catch.
 */

import { lookup as dnsLookup } from 'node:dns/promises';

import { resolveFinalUrl } from './addresses.js';

/** LiveKit's side of the deal. Matches what the Tusile voice stack uses everywhere. */
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
/** 10 ms. */
const FRAME_SAMPLES = SAMPLE_RATE / 100;
const FRAME_BYTES = FRAME_SAMPLES * 2;

/**
 * The ffmpeg command line.
 *
 * `-nostdin` because ffmpeg inherits our stdin otherwise and will happily eat a keystroke
 * meant for the terminal, and because without it a container with no tty can hang.
 * `-reconnect` because these are plain HTTP urls on somebody else's CDN: a dropped
 * connection a minute into a track used to end it, and ffmpeg can pick it up again from
 * where it was. `-vn` because an MP3 with album art is a video stream as far as ffmpeg is
 * concerned, and it will otherwise try to give us one.
 */
function ffmpegArgs(url, { seekMs = 0 } = {}) {
  const args = ['-nostdin', '-loglevel', 'error'];
  // ffmpeg speaks far more than HTTP. `-i` also accepts file:, concat:, data:, subfile:
  // and a few dozen others, and the url handed to it came from a third party index
  // describing files uploaded by strangers. Without this, a result whose url is
  // `file:///etc/passwd` is a bot reading a file off its host and playing it as noise into
  // a voice channel, and `concat:` is the same trick with a playlist. search.js refuses
  // anything that is not http, and this is the gate that still holds when somebody
  // replaces search.js with their own, which the README invites them to do.
  args.push('-protocol_whitelist', 'http,https,tcp,tls,crypto');
  // And it follows none. Every hop was walked and judged before we got here; letting
  // ffmpeg take one more would be the one nobody looked at, which is exactly how a url on
  // an ordinary public host reaches a metadata endpoint.
  args.push('-max_redirects', '0');
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  if (seekMs > 0) args.push('-ss', (seekMs / 1000).toFixed(3));
  args.push('-i', url);
  args.push('-vn');
  args.push('-ac', String(CHANNELS));
  args.push('-ar', String(SAMPLE_RATE));
  args.push('-f', 's16le');
  // Everybody uploads at a different level, and a CC0 field recording next to a mastered
  // track is the difference between inaudible and painful. loudnorm pins both to roughly
  // the same loudness. The single pass version is approximate, which is the right trade
  // when the alternative is analysing the whole file before the first sound.
  args.push('-af', 'loudnorm=I=-18:TP=-2:LRA=11');
  args.push('pipe:1');
  return args;
}

/**
 * Cut a stream of bytes into whole frames.
 *
 * Nothing guarantees that a chunk from a pipe is a multiple of 960 bytes, and handing
 * LiveKit a part frame is not a small error: the samples after it are interpreted half a
 * sample out, which is heard as a tearing noise for the rest of the track. The remainder
 * is carried to the next chunk.
 *
 * Returns the frames it could make and whatever was left over.
 */
function cutFrames(buffer) {
  const whole = Math.floor(buffer.length / FRAME_BYTES);
  const frames = [];
  for (let i = 0; i < whole; i++) {
    const start = i * FRAME_BYTES;
    // A copy, not a view. LiveKit holds the frame past this call, and a view into a
    // recycled pipe buffer is audio that changes after it has been handed over.
    const samples = new Int16Array(FRAME_SAMPLES);
    for (let s = 0; s < FRAME_SAMPLES; s++) {
      samples[s] = buffer.readInt16LE(start + s * 2);
    }
    frames.push(samples);
  }
  return { frames, rest: buffer.subarray(whole * FRAME_BYTES) };
}

/**
 * Decode a url into 10 ms frames.
 *
 * An async generator rather than a callback so the caller can simply stop pulling: that is
 * what /skip does, and it means cancellation needs no flag shared between two files.
 * Killing ffmpeg on the way out is in a finally, because a generator abandoned mid track
 * still has to not leave a process behind.
 */
async function* decode(url, { spawn, seekMs = 0, onError, lookup = dnsLookup, fetchImpl } = {}) {
  // The address filter in search.js reads what is written in the url, so it catches
  // `http://10.0.0.5/` and cannot catch a name that resolves to the same place. This is
  // the lookup that closes the plain case, and it lives here rather than in search.js
  // because the README invites people to replace search.js and not this.
  //
  // It does not close DNS rebinding: ffmpeg resolves the name again when it connects and
  // nothing here can make that answer the same one. The honest answer to rebinding is
  // egress rules on the network the bot runs on, which the README says.
  // Where this url actually ends, with every redirect judged on the way.
  //
  // ffmpeg follows redirects, so validating the url it is handed proves nothing on its
  // own: an ordinary public host answering 302 to http://169.254.169.254/ is every check
  // walked past in one hop. The hops are followed here instead and ffmpeg is told to
  // follow none.
  //
  // None of it closes DNS rebinding. ffmpeg resolves the name again when it connects and
  // nothing in this process can make that answer the same one. The honest answer to
  // rebinding is egress rules on the network the bot runs on, which the README says.
  let target;
  try {
    target = await resolveFinalUrl(url, { lookup, fetchImpl });
  } catch (err) {
    if (onError) onError(err);
    return;
  }

  const child = spawn('ffmpeg', ffmpegArgs(target, { seekMs }));
  let stderr = '';
  if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d); });

  let rest = Buffer.alloc(0);
  try {
    for await (const chunk of child.stdout) {
      const { frames, rest: left } = cutFrames(Buffer.concat([rest, chunk]));
      rest = left;
      for (const frame of frames) yield frame;
    }
    // ffmpeg writing nothing at all is the interesting failure: a dead link, a format it
    // cannot read, a 403 from a CDN. Without this the bot plays silence and says it played
    // the track, which is the single most confusing thing a music bot can do.
    if (child.exitCode !== 0 && child.exitCode !== null && onError) {
      onError(new Error(stderr.trim() || `ffmpeg exited ${child.exitCode}`));
    }
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

export {
  decode,
  cutFrames,
  ffmpegArgs,
  SAMPLE_RATE,
  CHANNELS,
  FRAME_SAMPLES,
  FRAME_BYTES,
};
