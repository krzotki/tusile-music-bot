import test from 'node:test';
import assert from 'node:assert/strict';

import { search, credit, playable, toTrack, MAX_DURATION_MS } from './search.js';

/** A row shaped the way Openverse really answers, which is where these fields come from. */
function row(over = {}) {
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

function fakeFetch(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return { ok, status, json: async () => body };
  };
  return { impl, calls };
}

test('a result comes back with everything needed to play it and to credit it', async () => {
  const { impl } = fakeFetch({ results: [row()] });
  const [track] = await search('lofi', { fetchImpl: impl });

  assert.equal(track.title, 'Keep me Alive');
  assert.equal(track.artist, 'JekK');
  assert.match(track.url, /^https:/);
  assert.equal(track.durationMs, 164000);
  assert.equal(track.licence, 'BY-NC-ND');
  assert.equal(track.source, 'jamendo');
});

// Every licence here except CC0 requires credit wherever the work is used. A bot that
// plays the audio and says nothing is the thing in this example that would be wrong to
// copy, so the credit line is part of the module rather than left to the command.
test('the credit line names the track, the artist and the licence', () => {
  assert.equal(credit(toTrack(row())), 'Keep me Alive by JekK | BY-NC-ND');
});

test('a row with no playable file is dropped, not offered', () => {
  assert.equal(playable(row({ url: undefined })), false);
  assert.equal(playable(row({ url: 'not-a-url' })), false);
});

// Openverse knows about plenty of Freesound entries whose duration it never learned, and
// they play perfectly. Dropping them would lose most of the CC0 catalogue.
test('a row with no duration is still offered', () => {
  assert.equal(playable(row({ duration: undefined })), true);
  assert.equal(toTrack(row({ duration: undefined })).durationMs, null);
});

// Queueing a twelve hour sleep loop by accident means nobody else gets a turn until
// somebody notices and runs /skip.
test('something far too long to queue is dropped', () => {
  assert.equal(playable(row({ duration: MAX_DURATION_MS + 1 })), false);
});

test('an empty query asks for nothing at all', async () => {
  const { impl, calls } = fakeFetch({ results: [row()] });
  assert.deepEqual(await search('   ', { fetchImpl: impl }), []);
  assert.equal(calls.length, 0, 'it searched for nothing');
});

// Rows get dropped for having no playable file, so asking Openverse for exactly as many as
// we mean to return is how a five result ask quietly becomes three.
test('it asks for more rows than it returns, and returns no more than asked', async () => {
  const { impl, calls } = fakeFetch({ results: Array.from({ length: 20 }, () => row()) });
  const out = await search('piano', { fetchImpl: impl, limit: 3 });

  assert.equal(out.length, 3);
  const asked = Number(new URL(calls[0].url).searchParams.get('page_size'));
  assert.ok(asked > 3, `page_size was ${asked}`);
});

test('a failed search says so rather than looking like no results', async () => {
  const { impl } = fakeFetch({}, { ok: false, status: 503 });
  await assert.rejects(() => search('lofi', { fetchImpl: impl }), /503/);
});

// Openverse throttles anonymous callers harder when they do not identify themselves.
test('it says who is calling', async () => {
  const { impl, calls } = fakeFetch({ results: [] });
  await search('lofi', { fetchImpl: impl });
  assert.match(calls[0].options.headers['User-Agent'], /tusile-music-bot/);
});

test('a body with no results at all is empty, not a crash', async () => {
  const { impl } = fakeFetch({});
  assert.deepEqual(await search('lofi', { fetchImpl: impl }), []);
});
