/**
 * Finding something to play.
 *
 * Openverse (openverse.org, run by the WordPress Foundation) indexes openly licensed audio
 * from Jamendo, Freesound, ccMixter and Wikimedia and hands back a direct link to the file.
 * It is the one music search worth building an example on: no account, no API key, no
 * billing page between somebody cloning this repo and hearing a sound. Every other free
 * music API wants a client id first.
 *
 * Nothing here is Tusile-specific. Swap this file for Jamendo, your own library, or a
 * folder of files on disk, keep the shape `search` returns, and the rest of the bot does
 * not notice.
 */

const ENDPOINT = 'https://api.openverse.org/v1/audio/';

/**
 * Anything longer than this is almost certainly a DJ set or a twelve hour sleep loop, and
 * queueing one by accident means nobody else gets a turn until somebody runs /skip.
 */
const MAX_DURATION_MS = 20 * 60 * 1000;

/**
 * A result worth offering.
 *
 * Openverse returns rows with no playable `url` (the index knows about the work, not the
 * file), and rows whose duration it never learned. A missing duration is kept: plenty of
 * Freesound entries have none and play perfectly. A missing url is not, because the only
 * thing the bot could do with one is fail after announcing it.
 */
function playable(row) {
  if (!row || typeof row.url !== 'string') return false;
  if (!reachesTheOutsideWorld(row.url)) return false;
  if (typeof row.duration === 'number' && row.duration > MAX_DURATION_MS) return false;
  return true;
}

/**
 * Hosts this bot will not be pointed at.
 *
 * A url from the index is a request this bot makes on somebody else's behalf, from inside
 * wherever it runs. A cloud metadata endpoint, an admin page on localhost, a service on the
 * private network: ffmpeg would fetch it, find no audio in it and move on, but the request
 * was still made from behind the firewall. A third party index describing files uploaded by
 * strangers does not get to choose which addresses this bot connects to.
 *
 * Literal addresses only, which is what this can honestly check: a name that resolves to a
 * private address is not caught here, and the answer to that is the network the bot runs
 * on, not a DNS lookup in a search filter that the connection would then not use anyway.
 */
function reachesTheOutsideWorld(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return false;
  }
  // IPv6 loopback and the v4-mapped forms of everything below it.
  if (host === '::1' || host.startsWith('::ffff:')) return false;
  // Unique local and link local addresses.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return false;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 0 || a === 127 || a === 10) return false;
    if (a === 169 && b === 254) return false; // link local, and the cloud metadata address
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier grade NAT
    if (a >= 224) return false; // multicast and above
  }
  return true;
}

/**
 * One search result, in the only shape the rest of the bot knows about.
 *
 * `licence` and `attribution` are not decoration. Every track here is under a Creative
 * Commons licence, and all of them except CC0 require credit to be given wherever the work
 * is used. A bot that plays the audio and says nothing is the part of this example that
 * would be wrong to copy, so the credit is built into the type rather than left to the
 * command to remember.
 */
function toTrack(row) {
  return {
    title: (row.title || 'Untitled').trim(),
    artist: (row.creator || 'Unknown artist').trim(),
    url: row.url,
    durationMs: typeof row.duration === 'number' ? row.duration : null,
    licence: (row.license || '').toUpperCase(),
    licenceUrl: row.license_url || null,
    pageUrl: row.foreign_landing_url || null,
    source: row.provider || 'openverse',
  };
}

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

/**
 * Search for something to play.
 *
 * `fetchImpl` is injected so the tests never touch the network, and so somebody running
 * this behind a proxy can hand in their own.
 */
async function search(query, { fetchImpl = fetch, limit = 5, signal } = {}) {
  const text = (query || '').trim();
  if (!text) return [];

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', text);
  // Asked for more than we return: rows get dropped for having no playable file, and
  // asking for exactly `limit` would quietly return three results for a five result ask.
  url.searchParams.set('page_size', String(Math.min(limit * 4, 20)));

  const res = await fetchImpl(url.toString(), {
    headers: {
      // Openverse asks anonymous callers to identify themselves, and throttles harder
      // when they do not.
      'User-Agent': 'tusile-music-bot (https://github.com/krzotki/tusile-music-bot)',
      Accept: 'application/json',
    },
    signal,
  });
  if (!res.ok) throw new Error(`search failed: ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body?.results) ? body.results : [];
  return rows.filter(playable).slice(0, limit).map(toTrack);
}

export { search, credit, playable, toTrack, reachesTheOutsideWorld, ENDPOINT, MAX_DURATION_MS };
