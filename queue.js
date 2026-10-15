/**
 * What is playing and what is next, for one voice channel.
 *
 * Deliberately has no idea what a track is beyond something with a title: it holds
 * whatever `search` returned. That keeps the only interesting rules in this file testable
 * without a network, a room or a bot.
 */

/**
 * How many tracks one person may have waiting.
 *
 * Without it the first person to find /play owns the evening: twenty queued tracks is two
 * hours, and everybody else is told to wait. The cap is per person rather than per queue
 * so that a busy channel still fills up, just not from one end.
 */
const PER_PERSON_LIMIT = 5;

class Queue {
  constructor({ perPersonLimit = PER_PERSON_LIMIT } = {}) {
    this.perPersonLimit = perPersonLimit;
    /** @type {{track: object, requestedBy: string}[]} */
    this.waiting = [];
    /** @type {{track: object, requestedBy: string}|null} */
    this.current = null;
  }

  /**
   * Put a track at the back.
   *
   * Returns the position it landed in, counting the one playing, so the answer can say
   * "next" or "third in the queue" rather than the uninformative "added".
   * Throws when the person already has their fill, because silently dropping a request is
   * how a bot gets a reputation for being broken.
   */
  add(track, requestedBy) {
    const theirs = this.waiting.filter((e) => e.requestedBy === requestedBy).length;
    if (theirs >= this.perPersonLimit) {
      throw new Error(`you already have ${theirs} tracks waiting`);
    }
    this.waiting.push({ track, requestedBy });
    return this.waiting.length + (this.current ? 1 : 0);
  }

  /** Take the next track, make it current, and return it. Null when there is nothing. */
  next() {
    this.current = this.waiting.shift() || null;
    return this.current;
  }

  /** Everything, in the order it will be heard, the one playing first. */
  list() {
    return [...(this.current ? [this.current] : []), ...this.waiting];
  }

  get size() {
    return this.waiting.length + (this.current ? 1 : 0);
  }

  /**
   * Forget everything, including what is playing.
   *
   * Clearing `current` matters: the player checks it to decide whether it is still meant
   * to be feeding audio, so a stop that left it set would hand the next track straight
   * back to a room that is being torn down.
   */
  clear() {
    this.waiting = [];
    this.current = null;
  }
}

/**
 * How long a list of tracks runs, in milliseconds, or null when any of them has no
 * duration and the total would be a lie.
 */
function totalDuration(entries) {
  let total = 0;
  for (const entry of entries) {
    const ms = entry.track?.durationMs;
    if (typeof ms !== 'number') return null;
    total += ms;
  }
  return total;
}

/** "3:07". Minutes and seconds, because nothing here runs for an hour. */
function clock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '?';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export { Queue, totalDuration, clock, PER_PERSON_LIMIT };
