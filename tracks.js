/**
 * What every music source shares: the limits a track has to fit, the licences the bot will
 * play, and how a source says it failed.
 *
 * Its own module so each source (openverse.js, jamendo.js, ccmixter.js) can use it without
 * importing search.js, which imports them.
 */

/**
 * Anything longer than this is almost certainly a DJ set or a twelve hour sleep loop, and
 * queueing one by accident means nobody else gets a turn until somebody runs /skip.
 */
const MAX_DURATION_MS = 20 * 60 * 1000;

/**
 * And anything shorter than this is not a track.
 *
 * Openverse indexes Freesound alongside Jamendo, and Freesound is sound effects. Asking
 * for `category=music` is the first line of defence and the better one, but a row can
 * simply have no category, and "Hey - Men Shouting together - Jewish Wedding", one second
 * long, is what reached a channel before either existed.
 */
const MIN_DURATION_MS = 30 * 1000;

/**
 * How many rows are asked for to return `limit` of them.
 *
 * More than `limit`, because rows get dropped for having no playable file or being a one
 * second clip, and asking for exactly `limit` is how a five result ask quietly becomes
 * three.
 *
 * Exported because the radio picks a page and has to know how big a page is. It computed
 * pages as though one row fitted in each, so a seed with thirty eight results could be
 * asked for page ten, find nothing, and end the radio. Caught by a live run, not by a test.
 *
 * Every source pages in these units, so a total from any of them means the same pages.
 */
function pageSizeFor(limit) {
  return Math.min(limit * 4, 20);
}

/** Whether a known duration fits. An unknown one (null) does: plenty play perfectly. */
function fitsDuration(ms) {
  if (typeof ms !== 'number' || Number.isNaN(ms)) return true;
  return ms >= MIN_DURATION_MS && ms <= MAX_DURATION_MS;
}

/**
 * The licences this bot plays, by the path creativecommons.org gives them.
 *
 * Creative Commons, including the retired sampling licences ccMixter still carries (and
 * Openverse already reported), plus CC0 and the public domain mark. Every one of them lets
 * the work be played with credit, and the bot gives the credit.
 */
const CC_LICENCES = new Set([
  'by', 'by-sa', 'by-nd', 'by-nc', 'by-nc-sa', 'by-nc-nd',
  'sampling', 'sampling+', 'nc-sampling+',
]);

/**
 * A licence url to the licence and a link to it, or null when it is not one we know.
 *
 * Jamendo and ccMixter both describe the licence by its url, and a url is the one thing
 * the credit needs anyway. Anything else, including a missing one, is a track the bot
 * cannot credit and so a track it does not play.
 */
function ccLicence(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hostname !== 'creativecommons.org' && url.hostname !== 'www.creativecommons.org') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const href = `https://creativecommons.org/${parts.join('/')}/`;
  if (parts[0] === 'licenses' && CC_LICENCES.has(parts[1])) {
    return { licence: parts[1].toUpperCase(), licenceUrl: href };
  }
  if (parts[0] === 'publicdomain' && parts[1] === 'zero') return { licence: 'CC0', licenceUrl: href };
  if (parts[0] === 'publicdomain' && parts[1] === 'mark') return { licence: 'PDM', licenceUrl: href };
  return null;
}

/**
 * A source that did not answer.
 *
 * `blocked` is the one that matters to the chain: a source that refused us (403, 429, a
 * page that is not the JSON it serves, a key it rejected) will refuse the next search too,
 * so it is skipped for a while instead of being asked again in front of every answer. A
 * timeout or a 503 is a bad minute and is simply asked again next time.
 */
class ProviderError extends Error {
  constructor(message, { blocked = false } = {}) {
    super(message);
    this.blocked = blocked;
  }
}

/** How a refusal looks in an HTTP status. */
const REFUSED = new Set([401, 403, 429]);

/**
 * Fetch and parse one source's JSON, turning every way it can fail into a ProviderError.
 *
 * Measured 2026-10-18: Openverse answers the production box with a 403 and Cloudflare's
 * "Just a moment..." page. Named in the message so the log line says what happened rather
 * than a bare 403.
 */
async function getJson(name, url, { fetchImpl = fetch, signal, headers = {} } = {}) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        'User-Agent': 'tusile-music-bot (https://github.com/krzotki/tusile-music-bot)',
        Accept: 'application/json',
        ...headers,
      },
      signal,
    });
  } catch (err) {
    throw new ProviderError(`${name} unreachable: ${err.message}`);
  }
  if (!res.ok) {
    let challenge = false;
    if (res.status === 403 && typeof res.text === 'function') {
      const body = await res.text().catch(() => '');
      challenge = /just a moment|cf-chl|challenge-platform|cloudflare/i.test(body);
    }
    throw new ProviderError(
      `${name} ${res.status}${challenge ? ' (Cloudflare challenge)' : ''}`,
      { blocked: REFUSED.has(res.status) },
    );
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderError(`${name} answered something that is not JSON`, { blocked: true });
  }
}

export {
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  pageSizeFor,
  fitsDuration,
  ccLicence,
  ProviderError,
  getJson,
};
