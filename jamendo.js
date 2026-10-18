/**
 * Jamendo (jamendo.com), asked directly.
 *
 * Most of what Openverse plays is Jamendo's anyway, and Jamendo answers the production box
 * when Openverse does not. It wants a client id, which is free (devportal.jamendo.com), so
 * it is asked only when JAMENDO_CLIENT_ID is set. Without one the chain goes from Openverse
 * straight to ccMixter.
 */

import { publicUrl } from './addresses.js';
import { ccLicence, fitsDuration, pageSizeFor, getJson, ProviderError } from './tracks.js';

const ENDPOINT = 'https://api.jamendo.com/v3.0/tracks/';

/** A Jamendo track to the bot's shape, or null when it cannot be played or credited. */
function toTrack(row) {
  if (!row) return null;
  const url = publicUrl(row.audio);
  if (url === null) return null;
  const licence = ccLicence(row.license_ccurl);
  if (licence === null) return null;
  // Seconds, where Openverse counts milliseconds.
  const durationMs = typeof row.duration === 'number' ? row.duration * 1000 : null;
  if (!fitsDuration(durationMs)) return null;
  return {
    title: String(row.name || 'Untitled').trim(),
    artist: String(row.artist_name || 'Unknown artist').trim(),
    url,
    durationMs,
    licence: licence.licence,
    licenceUrl: licence.licenceUrl,
    pageUrl: row.shareurl || null,
    source: 'jamendo',
  };
}

const jamendo = {
  name: 'jamendo',
  enabled: (env = {}) => Boolean(env.JAMENDO_CLIENT_ID),

  async query({ text, limit, page, withTotal, fetchImpl, signal, env = {} }) {
    const size = pageSizeFor(limit);
    const url = new URL(ENDPOINT);
    url.searchParams.set('client_id', env.JAMENDO_CLIENT_ID);
    url.searchParams.set('format', 'json');
    url.searchParams.set('search', text);
    url.searchParams.set('limit', String(size));
    if (page && page > 1) url.searchParams.set('offset', String((page - 1) * size));
    // MP3 at 96 kbps VBR: what Openverse's Jamendo rows link to, and what ffmpeg is fed.
    url.searchParams.set('audioformat', 'mp32');
    url.searchParams.set('include', 'licenses');
    // The radio's total. Jamendo only counts when asked.
    if (withTotal) url.searchParams.set('fullcount', 'true');

    const body = await getJson('jamendo', url.toString(), { fetchImpl, signal });
    // Measured: a rejected client id is a 200 whose header says "failed", not a 401.
    if (body?.headers?.status !== 'success') {
      const why = body?.headers?.error_message || 'an answer that is not a search result';
      throw new ProviderError(`jamendo refused: ${why}`, { blocked: true });
    }
    const rows = Array.isArray(body.results) ? body.results : [];
    const tracks = rows.map(toTrack).filter(Boolean).slice(0, limit);
    return {
      tracks,
      total: body.headers.results_fullcount ?? body.headers.results_count ?? tracks.length,
    };
  },
};

export { jamendo, toTrack as jamendoTrack, ENDPOINT as JAMENDO_ENDPOINT };
