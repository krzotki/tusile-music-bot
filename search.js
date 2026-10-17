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

import { publicUrl } from './addresses.js';

const ENDPOINT = 'https://api.openverse.org/v1/audio/';

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
 */
function pageSizeFor(limit) {
  return Math.min(limit * 4, 20);
}

/**
 * A result worth offering.
 *
 * Openverse returns rows with no playable `url` (the index knows about the work, not the
 * file), and rows whose duration it never learned. A missing duration is kept: plenty of
 * Freesound entries have none and play perfectly. A missing url is not, because the only
 * thing the bot could do with one is fail after announcing it.
 */
function playable(row) {
  if (!row) return false;
  if (publicUrl(row.url) === null) return false;
  if (typeof row.duration === 'number') {
    if (row.duration > MAX_DURATION_MS) return false;
    if (row.duration < MIN_DURATION_MS) return false;
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
    url: publicUrl(row.url),
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
async function search(query, { fetchImpl = fetch, limit = 5, signal, page, withTotal } = {}) {
  const text = (query || '').trim();
  if (!text) return withTotal ? { tracks: [], total: 0 } : [];

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', text);
  // Asked for more than we return: rows get dropped for having no playable file, and
  // asking for exactly `limit` would quietly return three results for a five result ask.
  url.searchParams.set('page_size', String(pageSizeFor(limit)));
  // Music, as opposed to everything Openverse has heard. It indexes Freesound next to
  // Jamendo, so without this a search for "lofi" returns a twelve second guitar scrap and
  // a one second wedding shout among the actual tracks, and the first result wins.
  url.searchParams.set('category', 'music');
  // Only when asked for. The radio varies the page because Openverse has no "random", and
  // spelling out page=1 everywhere else would be noise in every other request.
  if (page && page > 1) url.searchParams.set('page', String(page));

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
  const tracks = rows.filter(playable).slice(0, limit).map(toTrack);
  // The radio needs to know how much there is before it can pick a page in it. Everybody
  // else wants the tracks and nothing else, so the total is opt-in rather than a shape
  // every caller has to unwrap.
  return withTotal ? { tracks, total: body?.result_count ?? 0 } : tracks;
}

export { search, credit, playable, toTrack, pageSizeFor, ENDPOINT, MAX_DURATION_MS, MIN_DURATION_MS };
