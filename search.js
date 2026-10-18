/**
 * Finding something to play.
 *
 * Three sources, asked in order until one has something:
 *
 * 1. Openverse (openverse.js). No account, no API key, and it indexes Jamendo, Freesound,
 *    ccMixter and Wikimedia together. When it answers, nothing else is asked.
 * 2. Jamendo (jamendo.js), only when JAMENDO_CLIENT_ID is set.
 * 3. ccMixter (ccmixter.js). No key.
 *
 * Why there is a chain at all, measured 2026-10-18: from the production boxes every
 * Openverse endpoint answers 403 with a Cloudflare "Just a moment..." page, whatever the
 * User-Agent, while a home connection gets 200. With Openverse alone every /play found
 * nothing and the log said "stations warmed: 0 of 18". Jamendo and ccMixter both answer
 * from the same box.
 *
 * A source falls through to the next when it fails (unreachable, an error status, a body
 * that is not the JSON it serves) or has nothing for the query. A source that refused us
 * is skipped for SKIP_MS, so a blocked Openverse is not a 403 in front of every answer,
 * and asked again after that, because a block can lift.
 *
 * Nothing here is Tusile-specific. Swap a source for your own library or a folder of files
 * on disk, keep the shape `toTrack` returns, and the rest of the bot does not notice.
 */

import { openverse, playable, toTrack, ENDPOINT } from './openverse.js';
import { jamendo } from './jamendo.js';
import { ccmixter } from './ccmixter.js';
import { MAX_DURATION_MS, MIN_DURATION_MS, pageSizeFor } from './tracks.js';

/** How long a source that refused us is left alone. */
const SKIP_MS = 30 * 60 * 1000;

const PROVIDERS = [openverse, jamendo, ccmixter];

/**
 * The line that gives credit, in the form the licences ask for: title, creator, licence.
 *
 * Kept as a function rather than a field so the caller can put it in an embed, a message
 * or a log without three of them drifting apart.
 */
function credit(track) {
  const parts = [`${track.title} by ${track.artist}`];
  if (track.licence) parts.push(track.licence);
  return parts.join(' | ');
}

function defaultLog(line) {
  console.log(new Date().toISOString(), line);
}

/**
 * A search with its own memory of which sources have refused it.
 *
 * The bot uses one, `search` below. Tests make their own so one test's blocked Openverse
 * is not the next test's.
 */
function createSearch({ providers = PROVIDERS, now = Date.now, log = defaultLog, skipMs = SKIP_MS } = {}) {
  /** source name -> the time it may be asked again. */
  const skipUntil = new Map();

  /**
   * Search for something to play.
   *
   * `fetchImpl` is injected so the tests never touch the network, and so somebody running
   * this behind a proxy can hand in their own. `env` is where JAMENDO_CLIENT_ID is read.
   *
   * `page` counts in pages of `pageSizeFor(limit)` rows, and `withTotal` answers how many
   * rows there are, for every source alike, so the radio can pick a page without knowing
   * which source it is talking to.
   */
  return async function search(query, {
    fetchImpl = fetch, limit = 5, signal, page, withTotal, env = process.env,
  } = {}) {
    const text = (query || '').trim();
    if (!text) return withTotal ? { tracks: [], total: 0 } : [];

    const reasons = [];
    let answered = null;
    for (const provider of providers) {
      if (!provider.enabled(env)) continue;
      const until = skipUntil.get(provider.name) ?? 0;
      if (until > now()) {
        reasons.push(`${provider.name} skipped until ${new Date(until).toISOString()}`);
        continue;
      }
      try {
        const out = await provider.query({ text, limit, page, withTotal, fetchImpl, signal, env });
        skipUntil.delete(provider.name);
        if (out.tracks.length > 0) return withTotal ? out : out.tracks;
        answered = answered ?? out;
      } catch (err) {
        // An abort is the caller giving up, not the source failing: nobody else is asked.
        if (signal?.aborted) throw err;
        reasons.push(err.message);
        if (err.blocked) {
          skipUntil.set(provider.name, now() + skipMs);
          log(`search: ${err.message}; skipping ${provider.name} for ${Math.round(skipMs / 60000)} minutes`);
        }
      }
    }

    // Somebody answered and had nothing: that is no results, not a failure.
    if (answered) return withTotal ? { tracks: [], total: 0 } : [];
    throw new Error(`search failed: ${reasons.join('; ') || 'no source configured'}`);
  };
}

/** The search the bot uses. One memory for the whole process. */
const search = createSearch();

export {
  search,
  createSearch,
  credit,
  playable,
  toTrack,
  pageSizeFor,
  ENDPOINT,
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  SKIP_MS,
};
