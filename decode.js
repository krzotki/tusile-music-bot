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

import { openAudioStream } from './stream.js';


/** LiveKit's side of the deal. Matches what the Tusile voice stack uses everywhere. */
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
/** 10 ms. */
const FRAME_SAMPLES = SAMPLE_RATE / 100;
const FRAME_BYTES = FRAME_SAMPLES * 2;

/**
 * The ffmpeg command line.
 *
 * `-nostdin` is gone with the network: stdin is the audio now. What is left is the one
 * input ffmpeg still has, a pipe, and the format it must produce.
 *
 * `-vn` because an MP3 with album art is a video stream as far as ffmpeg is concerned,
 * and it will otherwise try to give us one. No protocol whitelist, no redirect limit and
 * no reconnect flags, because ffmpeg no longer opens a connection: stream.js does that,
 * with the address pinned, and hands over the bytes.
 */
function ffmpegArgs({ seekMs = 0 } = {}) {
  const args = ['-loglevel', 'error'];
  if (seekMs > 0) args.push('-ss', (seekMs / 1000).toFixed(3));
  // The audio arrives on stdin. ffmpeg probes the pipe for the format, which it manages
  // for everything Openverse serves; what it cannot do from a pipe is seek backwards, and
  // nothing here ever asks it to.
  args.push('-i', 'pipe:0');
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
async function* decode(url, { spawn, seekMs = 0, onError, openStream = openAudioStream,
  lookup, requestImpl } = {}) {
  // The bytes, fetched here rather than by ffmpeg.
  //
  // Every earlier version judged a url and then handed it to ffmpeg, which resolved the
  // name again when it connected. Between the two lookups the answer can change, which is
  // DNS rebinding, and nothing on this side could make ffmpeg's answer match ours. Now
  // there is one lookup, inside the socket that uses it, and ffmpeg reads a pipe.
  let body;
  try {
    body = await openStream(url, { lookup, requestImpl });
  } catch (err) {
    if (onError) onError(err);
    return;
  }

  const child = spawn('ffmpeg', ffmpegArgs({ seekMs }));
  let stderr = '';
  if (child.stderr) child.stderr.on('data', (d) => { stderr += String(d); });

  // Piped rather than awaited: this has to run while frames are being pulled out the other
  // end, and both ends are this process. EPIPE is the normal way it finishes when a track
  // is skipped, so it is swallowed: ffmpeg is already gone and the pipe closing behind it
  // is not news.
  if (child.stdin) {
    child.stdin.on('error', () => {});
    body.pipe(child.stdin);
  }

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
    // The socket as well as the process. Abandoning the generator mid track is what /skip
    // does, and a connection left open is a track still being downloaded for nobody.
    body.destroy?.();
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
