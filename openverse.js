/**
 * Openverse (openverse.org, run by the WordPress Foundation).
 *
 * It indexes openly licensed audio from Jamendo, Freesound, ccMixter and Wikimedia and hands
 * back a direct link to the file, with no account and no API key. It is the first source
 * asked, and when it answers the bot behaves exactly as it always has.
 *
 * It does not always answer. Measured 2026-10-18: from the production boxes every endpoint
 * answers 403 with a Cloudflare challenge page, whatever the User-Agent, while a home
 * connection gets 200. search.js then falls through to the next source.
 */

import { publicUrl } from './addresses.js';
import { fitsDuration, pageSizeFor, getJson } from './tracks.js';

const ENDPOINT = 'https://api.openverse.org/v1/audio/';

/**
 * A result worth offering.
 *
 * Openverse returns rows with no playable `url` (the index knows about the work, not the
 * file), and rows whose duration it never learned. A missing duration is kept: plenty of
 * Freesound entries have none and play perfectly. A missing url is not, because the only
 * thing the bot could do with one is fail after announcing it. Nor is a missing licence,
 * because the bot names the licence on every answer and cannot name one it was not told.
 */
function playable(row) {
  if (!row) return false;
  if (publicUrl(row.url) === null) return false;
  if (!row.license) return false;
  if (typeof row.duration === 'number' && !fitsDuration(row.duration)) return false;
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

const openverse = {
  name: 'openverse',
  enabled: () => true,

  async query({ text, limit, page, fetchImpl, signal }) {
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

    // Openverse asks anonymous callers to identify themselves, and throttles harder when
    // they do not. getJson sends the User-Agent.
    const body = await getJson('openverse', url.toString(), { fetchImpl, signal });
    const rows = Array.isArray(body?.results) ? body.results : [];
    return {
      tracks: rows.filter(playable).slice(0, limit).map(toTrack),
      total: body?.result_count ?? 0,
    };
  },
};

export { openverse, playable, toTrack, ENDPOINT };
