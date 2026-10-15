/**
 * One voice channel, one room, one queue draining into it.
 *
 * The part that is easy to get wrong is not the audio, it is the lifetime. A session
 * outlives the command that created it, several commands reach into it while it runs, and
 * it has to end cleanly whether the queue ran out, somebody said stop, the room dropped,
 * or ffmpeg failed on track four. So there is exactly one loop, in `pump`, and everything
 * else sets a flag it reads.
 */

import { decode, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES } from './decode.js';
import { Queue } from './queue.js';

/**
 * Silence before the first sample.
 *
 * Publishing a track does not mean anybody is receiving it: the people in the channel are
 * told a track exists, they subscribe, and the two sides negotiate. Audio played during
 * that is simply gone. Found the hard way on the support bot, where a two second tune was
 * missing its first second every time.
 */
const LEAD_IN_MS = 700;

/** Let the last frames actually leave before hanging up. */
const TAIL_MS = 400;

/**
 * The longest any one track may hold the channel, counted in frames actually played.
 *
 * search.js has a twenty minute limit too, and it is advisory: it reads the index's own
 * metadata, and a row with no duration is kept on purpose, because most of the CC0
 * catalogue has none. So a twelve hour stream with no duration field walks straight past
 * it, and a live radio url never ends at all.
 *
 * This one counts what was played, which no metadata can lie about. Twenty five minutes,
 * a little over the search limit, so an ordinary long track reaches its real end rather
 * than being cut off a few seconds early by a rounding difference.
 */
const MAX_FRAMES = 25 * 60 * 100;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  /**
   * @param {object} deps
   * @param {object} deps.server   the community, from the SDK
   * @param {string} deps.channelId
   * @param {(text: string) => void} deps.log
   * @param {(url: string, token: string) => Promise<object>} deps.connect
   * @param {(cmd: string, args: string[]) => object} deps.spawn
   * @param {(track: object) => Promise<void>} [deps.announce] called as each track starts
   */
  constructor({ server, channelId, log, connect, spawn, announce, openStream,
    sleep = defaultSleep }) {
    this.server = server;
    this.channelId = channelId;
    this.log = log;
    this.connect = connect;
    this.spawn = spawn;
    this.announce = announce;
    this.sleep = sleep;
    // Injected only so the tests need no network; decode opens the real connection
    // otherwise.
    this.openStream = openStream;
    this.maxFrames = MAX_FRAMES;

    this.queue = new Queue();
    this.room = null;
    this.running = false;
    /** Set by skip(); read once per frame and cleared when the track ends. */
    this.skipping = false;
    /** Set by stop(); never cleared, because a stopped session is not restarted. */
    this.stopped = false;
  }

  /**
   * Queue a track, starting the session if it is not already going.
   *
   * Returns the position, so the answer can be specific. The pump is deliberately not
   * awaited: /play has ten seconds to answer and a track runs for three minutes.
   */
  async enqueue(track, requestedBy) {
    if (this.stopped) throw new Error('this session has ended');
    const position = this.queue.add(track, requestedBy);
    if (!this.running) {
      this.running = true;
      this.pump().catch((err) => this.log(`pump died: ${err.message}`));
    }
    return position;
  }

  /** Abandon the current track. The loop notices within one frame, so 10 ms. */
  skip() {
    const was = this.queue.current;
    this.skipping = true;
    return was;
  }

  /** End everything and leave the channel. */
  async stop() {
    this.stopped = true;
    this.skipping = true;
    this.queue.clear();
    await this.hangUp();
  }

  /**
   * Connect, publish, and feed frames until there is nothing left to feed.
   *
   * Only ever one of these per session: `running` is set before it starts and cleared in
   * the finally, and `enqueue` is the only caller.
   */
  async pump() {
    try {
      await this.join();
      await this.sleep(LEAD_IN_MS);

      while (!this.stopped) {
        const entry = this.queue.next();
        if (!entry) break;
        this.skipping = false;
        if (this.announce) {
          // A failure to announce is not a reason to stop the music. The channel may have
          // been deleted, the bot may have lost permission to post in it: neither stops
          // the people in the voice channel hearing the track.
          await this.announce(entry).catch((err) => this.log(`could not announce: ${err.message}`));
        }
        await this.playOne(entry.track);
      }

      if (this.room?.drain) await this.room.drain();
      await this.sleep(TAIL_MS);
    } finally {
      this.running = false;
      await this.hangUp();
    }
  }

  /**
   * Feed one track's frames into the room.
   *
   * `captureFrame` paces itself: it returns when the source is ready for the next 10 ms,
   * which makes it the clock as well as the transport. That is why there is no timer
   * anywhere in here, and why skipping is checked per frame rather than per track.
   */
  async playOne(track) {
    let frames = 0;
    try {
      for await (const samples of decode(track.url, {
        spawn: this.spawn,
        ...(this.openStream ? { openStream: this.openStream } : {}),
        onError: (err) => this.log(`ffmpeg: ${track.title}: ${err.message}`),
      })) {
        if (this.skipping || this.stopped) break;
        await this.room.publish(samples);
        frames += 1;
        if (frames >= this.maxFrames) {
          this.log(`${track.title} hit the length limit and was cut off`);
          break;
        }
      }
    } catch (err) {
      // One bad track must not end the evening. The queue moves on.
      this.log(`could not play ${track.title}: ${err.message}`);
    }
    if (frames === 0 && !this.skipping && !this.stopped) {
      this.log(`${track.title} produced no audio (${track.url})`);
    }
  }

  /** Tell the community the bot is in the channel, then open the room. */
  async join() {
    await this.server.joinVoice(this.channelId, { speaking: true });
    const { token, url } = await this.server.voiceToken(this.channelId);
    this.room = await this.connect(url, token);
  }

  /**
   * Leave, and be sure the channel does not show a bot with a live microphone that is not
   * playing anything. Every step swallows its own error: this runs on the way out of a
   * failure as often as a success, and a second failure here would hide the first.
   */
  async hangUp() {
    const room = this.room;
    this.room = null;
    if (room) await room.close().catch(() => {});
    await this.server.setVoiceState(this.channelId, { speaking: false }).catch(() => {});
    await this.server.leaveVoice(this.channelId).catch(() => {});
  }
}

/**
 * The real LiveKit room, with one published audio track.
 *
 * Imported inside the function so a bot that never plays anything does not load a native
 * module at startup, and taken off `default` because @livekit/rtc-node is CommonJS: Node
 * cannot see named exports through a native addon.
 */
async function connectToRoom(url, token) {
  const livekit = await import('@livekit/rtc-node');
  const { Room, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, AudioFrame } =
    livekit.default ?? livekit;

  const room = new Room();
  await room.connect(url, token, { autoSubscribe: false, dynacast: false });
  const source = new AudioSource(SAMPLE_RATE, CHANNELS);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await room.localParticipant.publishTrack(
    LocalAudioTrack.createAudioTrack('music', source),
    options,
  );
  return {
    publish: (samples) =>
      source.captureFrame(new AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES)),
    // Resolves once queued audio has been played out rather than merely accepted. Without
    // it the end of the last track is dropped on disconnect.
    drain: () => source.waitForPlayout(),
    close: () => room.disconnect(),
  };
}

export { Session, connectToRoom, LEAD_IN_MS, TAIL_MS, MAX_FRAMES };
