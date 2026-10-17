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

/**
 * A url is handed to ffmpeg, which then fetches it from inside wherever this bot runs.
 *
 * That makes any url the search index returns a request this bot makes on somebody else's
 * behalf, from behind whatever firewall it lives behind. A cloud metadata endpoint, an
 * admin page on localhost, a service on the private network: ffmpeg would fetch it, fail to
 * find audio in it, and the bot would move on, but the request was still made. The index is
 * a third party describing files uploaded by strangers, so it does not get to choose which
 * addresses this bot connects to.
 */
test('a url pointing inside the network is not offered', () => {
  for (const host of [
    'http://127.0.0.1/a.mp3',
    'http://localhost/a.mp3',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/a.mp3',
    'http://192.168.1.1/a.mp3',
    'http://172.16.0.1/a.mp3',
    'http://[::1]/a.mp3',
  ]) {
    assert.equal(playable(row({ url: host })), false, `${host} was offered`);
  }
});

/**
 * The same address, written so a filter does not recognise it.
 *
 * All of these are 127.0.0.1. Node's URL parser normalises every one of them, which is
 * why the check is written against the parsed hostname rather than the text, and why
 * these are here: the day somebody rewrites this filter against the raw string, they
 * break on this test rather than in production.
 */
test('loopback dressed up as something else is still loopback', () => {
  for (const url of [
    'http://2130706433/a.mp3',
    'http://0177.0.0.1/a.mp3',
    'http://0x7f000001/a.mp3',
    'http://127.1/a.mp3',
    'http://[0:0:0:0:0:0:0:1]/a.mp3',
    'http://[::ffff:127.0.0.1]/a.mp3',
    'http://[::ffff:7f00:1]/a.mp3',
  ]) {
    assert.equal(playable(row({ url })), false, `${url} was offered`);
  }
});

/**
 * Credentials in a url are the oldest way of making one read as somewhere it is not, and
 * the two parsers that matter here do not have to agree about them: this filter uses
 * Node's, and the fetching is done by ffmpeg's. Nothing in an openly licensed music index
 * has a password in it, so the whole question is avoided rather than adjudicated.
 */
test('a url carrying credentials is refused rather than interpreted', () => {
  for (const url of [
    'http://evil.com@127.0.0.1/a.mp3',
    'http://user:pass@cdn.freesound.org/a.mp3',
    'http://cdn.freesound.org@evil.example/a.mp3',
  ]) {
    assert.equal(playable(row({ url })), false, `${url} was offered`);
  }
});

/**
 * ffmpeg must receive the url this filter judged, not the text it was judged from.
 *
 * Two parsers reading one string is where SSRF filters usually fail: whatever subtlety
 * Node's resolves one way and ffmpeg's resolves another is a gap by construction. Handing
 * on the normalised form removes the second parse.
 */
test('the url handed on is the parsed one, not the text it came from', () => {
  const track = toTrack(row({ url: 'http://CDN.Freesound.ORG:80/previews/1/1.mp3?x=1' }));
  assert.equal(track.url, 'http://cdn.freesound.org/previews/1/1.mp3?x=1');
});

test('an ordinary public url is still fine', () => {
  assert.equal(playable(row({ url: 'https://cdn.freesound.org/previews/1/1.mp3' })), true);
});

test('a url that is not http at all is not offered', () => {
  for (const url of ['file:///etc/passwd', 'concat:a|b', 'data:audio/mp3;base64,AAA']) {
    assert.equal(playable(row({ url })), false, `${url} was offered`);
  }
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

/**
 * Asking for music, and getting music.
 *
 * Reported with a screenshot from RedChat's staging twin: /play lofi answered with "Hey -
 * Men Shouting together - Jewish Wedding", one second long. Openverse indexes Freesound
 * alongside Jamendo, and Freesound is sound effects. Nothing in the request or the filter
 * said which of the two was wanted, and the first result won.
 */
test('it asks Openverse for music, not for every sound it has', async () => {
  const { impl, calls } = fakeFetch({ results: [row()] });
  await search('lofi', { fetchImpl: impl });
  assert.equal(new URL(calls[0].url).searchParams.get('category'), 'music');
});

// A one second clip is not a track whatever it is filed under, and `category` is a field
// the index may simply not have for a row.
test('something far too short to be a track is dropped', () => {
  assert.equal(playable(row({ duration: 1000 })), false);
  assert.equal(playable(row({ duration: 12000 })), false);
  assert.equal(playable(row({ duration: 40000 })), true);
});

test('and a row with no duration at all is still offered', () => {
  // Having asked for music, the unknown-duration rows left are worth keeping: refusing
  // them would drop part of the catalogue to guard against a case the category filter
  // already handles.
  assert.equal(playable(row({ duration: undefined })), true);
});

// The radio varies by page, because Openverse has no "random" and the first page of ten
// queries is the same forty tracks every evening.
test('a page can be asked for, and page one is not spelled out', async () => {
  const { impl, calls } = fakeFetch({ results: [row()] });
  await search('jazz', { fetchImpl: impl, page: 4 });
  assert.equal(new URL(calls[0].url).searchParams.get('page'), '4');

  const { impl: plain, calls: plainCalls } = fakeFetch({ results: [row()] });
  await search('jazz', { fetchImpl: plain });
  assert.equal(new URL(plainCalls[0].url).searchParams.get('page'), null);
});

// The radio needs to know how much there is before it can pick a page in it.
test('the total is reported alongside the results', async () => {
  const { impl } = fakeFetch({ result_count: 431, results: [row()] });
  const out = await search('jazz', { fetchImpl: impl, withTotal: true });
  assert.equal(out.total, 431);
  assert.equal(out.tracks.length, 1);
});
