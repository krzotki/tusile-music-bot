/**
 * ccMixter (ccmixter.org), asked directly.
 *
 * Remixes and originals, every one under a Creative Commons licence, no key and no account.
 * It is the last source in the chain: the one that is always there, and answers the
 * production box when Openverse does not.
 *
 * Two things about it that are not obvious from its docs, both measured:
 *
 * - Its query API has no total in the result. `f=count` with the same filters answers
 *   `[2466]`, so the count is a second request, made only when the radio asks for a total.
 * - `f=json` repeats the body in a 90 KB response header that Node's fetch refuses, so
 *   this asks for `f=js`, the same JSON without it.
 * - Its mp3s are hotlink protected: no Referer is a 403 "Forbidden". stream.js names each
 *   hop's own origin as the referer, which is what lets these play.
 */

import { publicUrl } from './addresses.js';
import { ccLicence, fitsDuration, pageSizeFor, getJson, ProviderError } from './tracks.js';

const ENDPOINT = 'https://ccmixter.org/api/query';

/** "3:19" or "1:02:03" to milliseconds, or null. */
function parseClock(text) {
  if (typeof text !== 'string' || !/^\d+(:\d{1,2}){1,2}$/.test(text.trim())) return null;
  return text.trim().split(':').map(Number).reduce((acc, n) => acc * 60 + n, 0) * 1000;
}

/**
 * The file to play from an upload: the first audio file that is not a stem.
 *
 * An upload is a list of files, and after the mix come the parts it was made from ("piano",
 * "bass", marked as samples). Archives and the like have another media type.
 */
function mainFile(row) {
  const files = Array.isArray(row?.files) ? [...row.files] : [];
  files.sort((a, b) => (a.file_order ?? 0) - (b.file_order ?? 0));
  return files.find((f) => f?.file_format_info?.['media-type'] === 'audio'
    && f?.file_extra?.type !== 'samples') || null;
}

/** What the uploader said this upload is: a remix, an original, an a cappella, a sample. */
function kinds(row) {
  return String(row?.upload_extra?.ccud || '').split(',').map((s) => s.trim());
}

/** A ccMixter upload to the bot's shape, or null when it cannot be played or credited. */
function toTrack(row) {
  if (!row) return null;
  // An a cappella or a sample pack is material for a remix, not something to listen to.
  const k = kinds(row);
  if (k.includes('acappella') || k.includes('sample')) return null;
  const file = mainFile(row);
  if (!file) return null;
  const url = publicUrl(file.download_url);
  if (url === null) return null;
  const licence = ccLicence(row.license_url);
  if (licence === null) return null;
  const durationMs = parseClock(file.file_format_info?.ps);
  if (!fitsDuration(durationMs)) return null;
  return {
    title: String(row.upload_name || 'Untitled').trim(),
    artist: String(row.user_real_name || row.user_name || 'Unknown artist').trim(),
    url,
    durationMs,
    licence: licence.licence,
    licenceUrl: licence.licenceUrl,
    pageUrl: row.file_page_url || null,
    source: 'ccmixter',
  };
}

function queryUrl(format, text) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('f', format);
  url.searchParams.set('search', text);
  // Every word, not any: "acoustic guitar" with `any` is fifteen thousand uploads, most of
  // them neither.
  url.searchParams.set('search_type', 'all');
  url.searchParams.set('sort', 'rank');
  return url;
}

const ccmixter = {
  name: 'ccmixter',
  enabled: () => true,

  async query({ text, limit, page, withTotal, fetchImpl, signal }) {
    const size = pageSizeFor(limit);
    // `js`, not `json`. Measured: f=json also copies the whole body into an X-JSON response
    // header, ninety kilobytes for twenty uploads, and Node's fetch refuses any response
    // whose headers pass sixteen, so every search failed with UND_ERR_HEADERS_OVERFLOW.
    // f=js is the same JSON body without that header.
    const url = queryUrl('js', text);
    url.searchParams.set('limit', String(size));
    if (page && page > 1) url.searchParams.set('offset', String((page - 1) * size));

    // In parallel: the count is a second request, and nobody should wait for two in a row.
    const counting = withTotal
      ? getJson('ccmixter', queryUrl('count', text).toString(), { fetchImpl, signal })
        .then((b) => (Array.isArray(b) && typeof b[0] === 'number' ? b[0] : null))
        .catch(() => null)
      : Promise.resolve(null);

    const body = await getJson('ccmixter', url.toString(), { fetchImpl, signal });
    if (!Array.isArray(body)) {
      throw new ProviderError('ccmixter answered something that is not a list of uploads');
    }
    const tracks = body.map(toTrack).filter(Boolean).slice(0, limit);
    const count = await counting;
    // A count that failed leaves the radio on page one, which is still music.
    return { tracks, total: count ?? tracks.length };
  },
};

export { ccmixter, parseClock, toTrack as ccmixterTrack, ENDPOINT as CCMIXTER_ENDPOINT };
