import test from 'node:test';
import assert from 'node:assert/strict';

import { ccLicence } from './tracks.js';
import { openverse } from './openverse.js';
import { jamendo } from './jamendo.js';
import { ccmixter, parseClock } from './ccmixter.js';
import { createSearch, SKIP_MS } from './search.js';
import { createStationCache } from './stations.js';

/**
 * Where the music comes from when Openverse will not talk to us.
 *
 * Measured 2026-10-18: from the production boxes every Openverse endpoint, the auth token
 * one included, answers 403 with a Cloudflare "Just a moment..." page, whatever the
 * User-Agent. From a home connection it answers 200. So in production every /play found
 * nothing and every station failed to warm ("stations warmed: 0 of 18"). Jamendo and
 * ccMixter both answer from the same box.
 */

const CLOUDFLARE_PAGE =
  '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head>' +
  '<body><noscript>Enable JavaScript and cookies to continue</noscript></body></html>';

/** A fetch answering by url, recording every request. */
function routes(table) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url: String(url), options });
    for (const [match, answer] of table) {
      if (String(url).includes(match)) {
        const a = typeof answer === 'function' ? answer(String(url)) : answer;
        if (a instanceof Error) throw a;
        return response(a);
      }
    }
    throw new Error(`no route for ${url}`);
  };
  return { impl, calls };
}

function response({ status = 200, body, html }) {
  const text = html ?? JSON.stringify(body);
  return {
    ok: status >= 200 && status <= 299,
    status,
    headers: new Map([['content-type', html ? 'text/html' : 'application/json']]),
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

const blocked = { status: 403, html: CLOUDFLARE_PAGE };

/** An Openverse row as the API really answers. */
function ovRow(over = {}) {
  return {
    title: 'Keep me Alive',
    creator: 'JekK',
    url: 'https://prod-1.storage.jamendo.com/?trackid=1968662&format=mp32',
    duration: 164000,
    license: 'by-nc-nd',
    license_url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    foreign_landing_url: 'https://www.jamendo.com/track/1968662',
    provider: 'jamendo',
    ...over,
  };
}

/** A Jamendo v3.0 track, with the fields this bot reads, as the API answers them. */
function jmRow(over = {}) {
  return {
    id: '1968662',
    name: 'Keep me Alive',
    duration: 164,
    artist_name: 'JekK',
    audio: 'https://prod-1.storage.jamendo.com/?trackid=1968662&format=mp32',
    shareurl: 'https://www.jamendo.com/track/1968662',
    license_ccurl: 'http://creativecommons.org/licenses/by-nc-nd/3.0/',
    ...over,
  };
}

function jmBody(rows, over = {}) {
  return {
    headers: { status: 'success', code: 0, error_message: '', results_count: rows.length, ...over },
    results: rows,
  };
}

/** A ccMixter upload, trimmed from a live answer of /api/query?f=js. */
function ccRow(over = {}) {
  return {
    upload_id: 21907,
    upload_name: "don't you run (jazz mix)",
    upload_extra: { ccud: 'media,remix,bpm_110_115,editorial_pick' },
    user_name: 'oldDog',
    user_real_name: 'oldDog',
    file_page_url: 'https://ccmixter.org/files/oldDog/21907',
    license_url: 'http://creativecommons.org/licenses/by-nc/3.0/',
    license_name: 'Attribution Noncommercial  (3.0)',
    files: [
      {
        file_order: 0,
        file_format_info: { 'media-type': 'audio', 'default-ext': 'mp3', mime_type: 'audio/mpeg', ps: '3:19' },
        file_extra: {},
        download_url: 'https://ccmixter.org/content/oldDog/oldDog_-_don_t_you_run_(jazz_mix).mp3',
      },
      {
        file_order: 1,
        file_format_info: { 'media-type': 'audio', 'default-ext': 'mp3', ps: '0:35' },
        file_extra: { type: 'samples' },
        download_url: 'https://ccmixter.org/content/oldDog/stem.mp3',
      },
    ],
    ...over,
  };
}

const SHAPE = ['title', 'artist', 'url', 'durationMs', 'licence', 'licenceUrl', 'pageUrl', 'source'];

// ---- licences ----

/**
 * Every answer names the licence, because every licence here except CC0 and the public
 * domain mark requires credit. A track whose licence cannot be read is a track the bot
 * cannot credit, so it is not a track the bot plays.
 */
test('the Creative Commons licences are read off their urls', () => {
  assert.deepEqual(ccLicence('http://creativecommons.org/licenses/by-nc/3.0/'), {
    licence: 'BY-NC',
    licenceUrl: 'https://creativecommons.org/licenses/by-nc/3.0/',
  });
  assert.equal(ccLicence('https://creativecommons.org/licenses/by-sa/4.0/').licence, 'BY-SA');
  assert.equal(ccLicence('https://creativecommons.org/licenses/by-nc-nd/2.5/').licence, 'BY-NC-ND');
  assert.equal(ccLicence('http://creativecommons.org/licenses/nc-sampling+/1.0/').licence, 'NC-SAMPLING+');
  assert.equal(ccLicence('http://creativecommons.org/publicdomain/zero/1.0/').licence, 'CC0');
  assert.equal(ccLicence('https://creativecommons.org/publicdomain/mark/1.0/').licence, 'PDM');
});

test('anything that is not a Creative Commons or public domain licence is not one', () => {
  for (const url of [
    undefined,
    '',
    'not a url',
    'https://example.com/licenses/by/4.0/',
    'https://creativecommons.org.evil.example/licenses/by/4.0/',
    'https://creativecommons.org/licenses/all-rights-reserved/1.0/',
    'https://creativecommons.org/about/',
    'https://www.jamendo.com/legal',
  ]) {
    assert.equal(ccLicence(url), null, `${url} was read as a licence`);
  }
});

// ---- openverse ----

test('openverse: a Cloudflare challenge is a refusal, and says so', async () => {
  const { impl } = routes([['api.openverse.org', blocked]]);
  await assert.rejects(
    () => openverse.query({ text: 'jazz', limit: 5, fetchImpl: impl }),
    (err) => err.blocked === true && /403/.test(err.message) && /challenge/i.test(err.message),
  );
});

test('openverse: a 200 that is not JSON is a refusal too', async () => {
  const { impl } = routes([['api.openverse.org', { status: 200, html: CLOUDFLARE_PAGE }]]);
  await assert.rejects(
    () => openverse.query({ text: 'jazz', limit: 5, fetchImpl: impl }),
    (err) => err.blocked === true,
  );
});

test('openverse: a 503 is a failure but not a refusal', async () => {
  const { impl } = routes([['api.openverse.org', { status: 503, body: {} }]]);
  await assert.rejects(
    () => openverse.query({ text: 'jazz', limit: 5, fetchImpl: impl }),
    (err) => err.blocked === false && /503/.test(err.message),
  );
});

test('openverse: a row with no licence is not offered', async () => {
  const { impl } = routes([['api.openverse.org', { body: { result_count: 2, results: [ovRow({ license: '' }), ovRow()] } }]]);
  const { tracks, total } = await openverse.query({ text: 'jazz', limit: 5, fetchImpl: impl });
  assert.equal(tracks.length, 1);
  assert.equal(total, 2);
});

// ---- jamendo ----

test('jamendo: is only asked when a client id is configured', () => {
  assert.equal(jamendo.enabled({}), false);
  assert.equal(jamendo.enabled({ JAMENDO_CLIENT_ID: '' }), false);
  assert.equal(jamendo.enabled({ JAMENDO_CLIENT_ID: 'abc123' }), true);
});

test('jamendo: a track comes back in the shape the bot knows, with its licence', async () => {
  const { impl, calls } = routes([['api.jamendo.com', { body: jmBody([jmRow()], { results_fullcount: 812 }) }]]);
  const { tracks, total } = await jamendo.query({
    text: 'jazz', limit: 5, page: 3, withTotal: true, fetchImpl: impl, env: { JAMENDO_CLIENT_ID: 'abc123' },
  });

  assert.deepEqual(Object.keys(tracks[0]).sort(), [...SHAPE].sort());
  assert.deepEqual(tracks[0], {
    title: 'Keep me Alive',
    artist: 'JekK',
    url: 'https://prod-1.storage.jamendo.com/?trackid=1968662&format=mp32',
    durationMs: 164000,
    licence: 'BY-NC-ND',
    licenceUrl: 'https://creativecommons.org/licenses/by-nc-nd/3.0/',
    pageUrl: 'https://www.jamendo.com/track/1968662',
    source: 'jamendo',
  });
  assert.equal(total, 812);

  const asked = new URL(calls[0].url);
  assert.equal(asked.origin + asked.pathname, 'https://api.jamendo.com/v3.0/tracks/');
  assert.equal(asked.searchParams.get('client_id'), 'abc123');
  assert.equal(asked.searchParams.get('search'), 'jazz');
  assert.equal(asked.searchParams.get('audioformat'), 'mp32');
  assert.equal(asked.searchParams.get('fullcount'), 'true');
  // Page three of pages twenty rows long, the same pages the radio counts in.
  assert.equal(asked.searchParams.get('limit'), '20');
  assert.equal(asked.searchParams.get('offset'), '40');
});

test('jamendo: a track with no readable licence is skipped', async () => {
  const { impl } = routes([['api.jamendo.com', {
    body: jmBody([jmRow({ license_ccurl: '' }), jmRow({ license_ccurl: 'https://example.com/x' }), jmRow({ name: 'Kept' })]),
  }]]);
  const { tracks } = await jamendo.query({ text: 'jazz', limit: 5, fetchImpl: impl, env: { JAMENDO_CLIENT_ID: 'x' } });
  assert.deepEqual(tracks.map((t) => t.title), ['Kept']);
});

// Measured: a wrong client id is a 200 whose header says "failed", not a 401.
test('jamendo: a rejected client id is a refusal, not an empty result', async () => {
  const { impl } = routes([['api.jamendo.com', {
    body: { headers: { status: 'failed', code: 5, error_message: 'Jamendo Api Invalid Client Id Error' }, results: [] },
  }]]);
  await assert.rejects(
    () => jamendo.query({ text: 'jazz', limit: 5, fetchImpl: impl, env: { JAMENDO_CLIENT_ID: 'bad' } }),
    (err) => err.blocked === true && /Invalid Client Id/.test(err.message),
  );
});

test('jamendo: too short, too long and unplayable rows are dropped', async () => {
  const { impl } = routes([['api.jamendo.com', {
    body: jmBody([
      jmRow({ name: 'clip', duration: 4 }),
      jmRow({ name: 'set', duration: 3 * 3600 }),
      jmRow({ name: 'inside', audio: 'http://169.254.169.254/latest/meta-data/' }),
      jmRow({ name: 'fine' }),
    ]),
  }]]);
  const { tracks } = await jamendo.query({ text: 'jazz', limit: 5, fetchImpl: impl, env: { JAMENDO_CLIENT_ID: 'x' } });
  assert.deepEqual(tracks.map((t) => t.title), ['fine']);
});

// ---- ccmixter ----

test('ccmixter: an upload comes back in the shape the bot knows, with its licence', async () => {
  const { impl, calls } = routes([
    ['f=count', { body: [2466] }],
    ['f=js&', { body: [ccRow()] }],
  ]);
  const { tracks, total } = await ccmixter.query({ text: 'jazz', limit: 5, page: 2, withTotal: true, fetchImpl: impl });

  assert.deepEqual(tracks[0], {
    title: "don't you run (jazz mix)",
    artist: 'oldDog',
    url: 'https://ccmixter.org/content/oldDog/oldDog_-_don_t_you_run_(jazz_mix).mp3',
    durationMs: 199000,
    licence: 'BY-NC',
    licenceUrl: 'https://creativecommons.org/licenses/by-nc/3.0/',
    pageUrl: 'https://ccmixter.org/files/oldDog/21907',
    source: 'ccmixter',
  });
  assert.equal(total, 2466);

  const asked = new URL(calls.find((c) => c.url.includes('f=js&')).url);
  assert.equal(asked.origin + asked.pathname, 'https://ccmixter.org/api/query');
  // Not f=json. Measured live: f=json also copies the whole body into an X-JSON response
  // header (90 KB for twenty uploads), and Node's fetch refuses any response whose headers
  // pass 16 KB, so every f=json search fails with UND_ERR_HEADERS_OVERFLOW. f=js is the same
  // JSON body with no such header.
  assert.equal(asked.searchParams.get('f'), 'js');
  assert.equal(asked.searchParams.get('search'), 'jazz');
  assert.equal(asked.searchParams.get('search_type'), 'all');
  assert.equal(asked.searchParams.get('limit'), '20');
  assert.equal(asked.searchParams.get('offset'), '20');
});

test('ccmixter: the count is only asked for when somebody wants the total', async () => {
  const { impl, calls } = routes([['f=js&', { body: [ccRow()] }]]);
  const out = await ccmixter.query({ text: 'jazz', limit: 5, fetchImpl: impl });
  assert.equal(out.tracks.length, 1);
  assert.equal(calls.length, 1);
});

test('ccmixter: a count that fails still leaves the tracks, with a total from them', async () => {
  const { impl } = routes([
    ['f=count', { status: 500, body: {} }],
    ['f=js&', { body: [ccRow()] }],
  ]);
  const out = await ccmixter.query({ text: 'jazz', limit: 5, withTotal: true, fetchImpl: impl });
  assert.equal(out.tracks.length, 1);
  assert.equal(out.total, 1);
});

test('ccmixter: an upload with no licence, or only stems, or a cappella, is skipped', async () => {
  const stemOnly = ccRow({ upload_name: 'stems', files: [ccRow().files[1]] });
  const { impl } = routes([['f=js&', {
    body: [
      ccRow({ upload_name: 'no licence', license_url: '' }),
      ccRow({ upload_name: 'odd licence', license_url: 'http://ccmixter.org/terms' }),
      stemOnly,
      ccRow({ upload_name: 'vocals', upload_extra: { ccud: 'acappella' } }),
      ccRow({ upload_name: 'zip', files: [{ file_format_info: { 'media-type': 'archive' }, download_url: 'https://ccmixter.org/a.zip' }] }),
      ccRow({ upload_name: 'kept' }),
    ],
  }]]);
  const { tracks } = await ccmixter.query({ text: 'jazz', limit: 10, fetchImpl: impl });
  assert.deepEqual(tracks.map((t) => t.title), ['kept']);
});

test('ccmixter: something that is not a list is a failure, not an empty result', async () => {
  const { impl } = routes([['f=js&', { body: { error: 'nope' } }]]);
  await assert.rejects(() => ccmixter.query({ text: 'jazz', limit: 5, fetchImpl: impl }));
});

test('ccmixter: its clock reads minutes and hours', () => {
  assert.equal(parseClock('3:19'), 199000);
  assert.equal(parseClock('1:02:03'), 3723000);
  assert.equal(parseClock(''), null);
  assert.equal(parseClock(undefined), null);
});

// ---- the chain ----

const ovOk = { body: { result_count: 431, results: [ovRow({ title: 'from openverse' })] } };
const jmOk = { body: jmBody([jmRow({ name: 'from jamendo' })], { results_fullcount: 90 }) };
const ccOk = { body: [ccRow({ upload_name: 'from ccmixter' })] };

function chain(over = {}) {
  let clock = 1_000_000;
  const lines = [];
  const search = createSearch({ now: () => clock, log: (l) => lines.push(l), ...over });
  return { search, lines, advance: (ms) => { clock += ms; } };
}

test('chain: Openverse answers first when it works, and nothing else is asked', async () => {
  const { search } = chain();
  const { impl, calls } = routes([['api.openverse.org', ovOk], ['api.jamendo.com', jmOk], ['ccmixter.org', ccOk]]);
  const out = await search('jazz', { fetchImpl: impl, env: { JAMENDO_CLIENT_ID: 'x' } });
  assert.deepEqual(out.map((t) => t.title), ['from openverse']);
  assert.equal(calls.length, 1);
});

test('chain: blocked Openverse falls to Jamendo when there is a client id', async () => {
  const { search } = chain();
  const { impl } = routes([['api.openverse.org', blocked], ['api.jamendo.com', jmOk], ['ccmixter.org', ccOk]]);
  const out = await search('jazz', { fetchImpl: impl, env: { JAMENDO_CLIENT_ID: 'x' } });
  assert.deepEqual(out.map((t) => t.title), ['from jamendo']);
});

test('chain: and to ccMixter when there is not', async () => {
  const { search } = chain();
  const { impl, calls } = routes([['api.openverse.org', blocked], ['api.jamendo.com', jmOk], ['ccmixter.org', ccOk]]);
  const out = await search('jazz', { fetchImpl: impl, env: {} });
  assert.deepEqual(out.map((t) => t.title), ['from ccmixter']);
  assert.ok(!calls.some((c) => c.url.includes('jamendo')), 'it asked Jamendo with no client id');
});

test('chain: a provider with nothing for the query falls through too', async () => {
  const { search } = chain();
  const { impl } = routes([
    ['api.openverse.org', { body: { result_count: 0, results: [] } }],
    ['ccmixter.org', ccOk],
  ]);
  const out = await search('jazz', { fetchImpl: impl, env: {} });
  assert.deepEqual(out.map((t) => t.title), ['from ccmixter']);
});

test('chain: a network error falls through', async () => {
  const { search } = chain();
  const { impl } = routes([
    ['api.openverse.org', new TypeError('fetch failed')],
    ['ccmixter.org', ccOk],
  ]);
  const out = await search('jazz', { fetchImpl: impl, env: {} });
  assert.deepEqual(out.map((t) => t.title), ['from ccmixter']);
});

/**
 * Not hitting a 403 on every search.
 *
 * Openverse blocking the box is not a bad minute, it is a property of the address, so
 * asking it again on every search is a wasted round trip in front of every answer. It is
 * asked again after a while, because the block may lift.
 */
test('chain: after a refusal Openverse is skipped for a while, then tried again', async () => {
  const { search, advance, lines } = chain();
  const { impl, calls } = routes([['api.openverse.org', blocked], ['ccmixter.org', ccOk]]);
  const ovCalls = () => calls.filter((c) => c.url.includes('openverse')).length;

  await search('jazz', { fetchImpl: impl, env: {} });
  assert.equal(ovCalls(), 1);
  assert.ok(lines.some((l) => /openverse/.test(l) && /30 minutes/.test(l)), lines.join('\n'));

  await search('rock', { fetchImpl: impl, env: {} });
  advance(SKIP_MS - 1000);
  await search('funk', { fetchImpl: impl, env: {} });
  assert.equal(ovCalls(), 1, 'it asked Openverse again inside the skip window');

  advance(2000);
  await search('folk', { fetchImpl: impl, env: {} });
  assert.equal(ovCalls(), 2, 'it never retried Openverse once the window passed');
});

test('chain: a plain failure is not remembered', async () => {
  const { search } = chain();
  const { impl, calls } = routes([['api.openverse.org', { status: 503, body: {} }], ['ccmixter.org', ccOk]]);
  await search('jazz', { fetchImpl: impl, env: {} });
  await search('jazz', { fetchImpl: impl, env: {} });
  assert.equal(calls.filter((c) => c.url.includes('openverse')).length, 2);
});

test('chain: when every provider fails, it says so with each reason', async () => {
  const { search } = chain();
  const { impl } = routes([['api.openverse.org', blocked], ['ccmixter.org', { status: 502, body: {} }]]);
  await assert.rejects(
    () => search('jazz', { fetchImpl: impl, env: {} }),
    (err) => /search failed/.test(err.message) && /openverse/.test(err.message) && /ccmixter 502/.test(err.message),
  );
});

test('chain: when one answered empty and the rest failed, it is empty, not an error', async () => {
  const { search } = chain();
  const { impl } = routes([
    ['api.openverse.org', { body: { result_count: 0, results: [] } }],
    ['ccmixter.org', { status: 502, body: {} }],
  ]);
  assert.deepEqual(await search('jazz', { fetchImpl: impl, env: {} }), []);
});

test('chain: the total comes from the provider that answered', async () => {
  const { search } = chain();
  const { impl } = routes([
    ['api.openverse.org', blocked],
    ['f=count', { body: [2466] }],
    ['f=js&', ccOk],
  ]);
  const out = await search('jazz', { fetchImpl: impl, env: {}, withTotal: true });
  assert.equal(out.total, 2466);
  assert.deepEqual(out.tracks.map((t) => t.title), ['from ccmixter']);
});

test('chain: every track from every provider has the full shape', async () => {
  for (const table of [
    [['api.openverse.org', ovOk]],
    [['api.openverse.org', blocked], ['api.jamendo.com', jmOk]],
    [['api.openverse.org', blocked], ['ccmixter.org', ccOk]],
  ]) {
    const { search } = chain();
    const { impl } = routes(table);
    const [t] = await search('jazz', { fetchImpl: impl, env: { JAMENDO_CLIENT_ID: 'x' } });
    assert.deepEqual(Object.keys(t).sort(), [...SHAPE].sort());
    assert.ok(t.licence && t.licenceUrl, `${t.source} track has no licence`);
  }
});

test('chain: an abort is not a reason to ask somebody else', async () => {
  const { search } = chain();
  const ctrl = new AbortController();
  const { impl, calls } = routes([
    ['api.openverse.org', () => { ctrl.abort(); return new Error('aborted'); }],
    ['ccmixter.org', ccOk],
  ]);
  await assert.rejects(() => search('jazz', { fetchImpl: impl, env: {}, signal: ctrl.signal }));
  assert.equal(calls.length, 1);
});

/**
 * The production failure itself: Openverse refuses the box, and the stations warm anyway.
 */
test('the stations warm from a fallback when Openverse refuses the box', async () => {
  const { search } = chain();
  const { impl } = routes([['api.openverse.org', blocked], ['ccmixter.org', ccOk]]);
  const lines = [];
  const cache = createStationCache({
    stations: ['jazz', 'rock', 'lofi'],
    search: (s) => search(s, { limit: 5, fetchImpl: impl, env: {} }),
    log: (l) => lines.push(l),
  });
  const warmed = await cache.warm();
  assert.equal(warmed, 3, lines.join('\n'));
  assert.ok(lines.includes('stations warmed: 3 of 3'));
  const got = await cache.take('jazz');
  assert.equal(got[0].source, 'ccmixter');
});

/**
 * The radio, end to end through the real chain, with Openverse refusing.
 *
 * It learns the total from ccMixter, picks pages of the size the request really uses, and
 * the page it picks is an offset ccMixter is actually asked for.
 */
test('the radio plays from a fallback and wanders its pages', async () => {
  const { handle } = await import('./commands.js');
  const { Queue } = await import('./queue.js');
  const { search } = chain();
  const { impl, calls } = routes([
    ['api.openverse.org', blocked],
    ['f=count', { body: [400] }],
    ['f=js&', (url) => {
      const offset = Number(new URL(url).searchParams.get('offset') || 0);
      return { body: Array.from({ length: 5 }, (_, i) => ccRow({ upload_name: `at ${offset + i}` })) };
    }],
  ]);
  const played = [];
  const session = {
    queue: new Queue(),
    stopped: false,
    radio: false,
    refill: null,
    enqueue: async (t) => { played.push(t); return 1; },
  };
  const ctx = {
    userId: 'u-1',
    channelId: 'c-1',
    userVoiceChannelId: 'v1',
    log: () => {},
    search: (q, opts) => search(q, { ...opts, fetchImpl: impl, env: {} }),
    defer: async () => {},
    update: async () => {},
    stations: { take: async () => [] },
    sessionFor: () => session,
    liveSession: () => session,
    server: { send: async () => {} },
  };
  await handle({ command: 'radio', options: { station: 'jazz' } }, ctx);
  assert.equal(played.length, 1, 'the radio started nothing');
  assert.equal(played[0].source, 'ccmixter');
  assert.equal(played[0].licence, 'BY-NC');

  for (let i = 0; i < 15; i++) {
    session.queue = new Queue();
    assert.equal(await session.refill(), true, 'a refill found nothing');
  }
  const offsets = calls
    .filter((c) => c.url.includes('f=js&'))
    .map((c) => Number(new URL(c.url).searchParams.get('offset') || 0));
  assert.ok(offsets.some((o) => o > 0), `it never left page one: ${offsets.join(',')}`);
  assert.ok(offsets.every((o) => o % 20 === 0 && o < 400), `an offset off the page grid: ${offsets.join(',')}`);
});
