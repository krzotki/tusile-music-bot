import test from 'node:test';
import assert from 'node:assert/strict';

import { isPublicHost, publicUrl, resolveFinalUrl } from './addresses.js';

/**
 * The forms of loopback that are not written as loopback.
 *
 * `[::127.0.0.1]` is the IPv4-compatible form. The URL parser normalises it to
 * `[::7f00:1]`, which matches no IPv4 rule and, until these tests existed, matched no IPv6
 * rule either: it is neither `::1` nor `::ffff:` prefixed, so it fell through to "a public
 * IPv6 address" and was offered.
 */
test('an IPv4 address smuggled inside an IPv6 one is still that address', () => {
  for (const host of [
    '[::127.0.0.1]', '[::7f00:1]', '[::10.0.0.1]', '[::a00:1]',
    '[::169.254.169.254]', '[::a9fe:a9fe]',
    '[64:ff9b::127.0.0.1]', '[64:ff9b::7f00:1]',
  ]) {
    assert.equal(isPublicHost(host), false, `${host} was allowed`);
  }
});

test('and a real IPv6 address is not refused along with them', () => {
  for (const host of ['[2606:4700:4700::1111]', '[2a00:1450:4001:80e::200e]']) {
    assert.equal(isPublicHost(host), true, `${host} was refused`);
  }
});

test('the unspecified address and its v4 form are refused', () => {
  assert.equal(isPublicHost('[::]'), false);
  assert.equal(isPublicHost('0.0.0.0'), false);
  assert.equal(isPublicHost('[::ffff:0:0]'), false);
});

/**
 * ffmpeg follows redirects, so validating the url it is handed proves nothing on its own.
 *
 * A url on a perfectly ordinary public host answering 302 to http://169.254.169.254/ was
 * every check in this file walked past in one hop: the address was judged, the name was
 * resolved, and then ffmpeg was told to go somewhere else entirely. The redirects are
 * followed here instead, each hop judged like the first, and ffmpeg is told not to follow
 * any.
 */
test('a redirect to somewhere inside the network is refused', async () => {
  const fetchImpl = async () => ({
    status: 302,
    headers: { get: (h) => (h.toLowerCase() === 'location' ? 'http://169.254.169.254/' : null) },
  });
  await assert.rejects(
    () => resolveFinalUrl('https://cdn.example.com/a.mp3', { fetchImpl, lookup: outside }),
    /not a public address|169\.254/,
  );
});

test('a redirect to another public host is followed and its destination returned', async () => {
  let hop = 0;
  const fetchImpl = async () => {
    hop += 1;
    if (hop === 1) {
      return {
        status: 301,
        headers: { get: () => 'https://cdn2.example.com/real.mp3' },
      };
    }
    return { status: 200, headers: { get: () => null } };
  };
  const final = await resolveFinalUrl('https://cdn.example.com/a.mp3', {
    fetchImpl,
    lookup: outside,
  });
  assert.equal(final, 'https://cdn2.example.com/real.mp3');
});

// A relative Location is legal and common, and resolving it against the wrong base is
// another way to end up somewhere nobody checked.
test('a relative redirect is resolved against the url it came from', async () => {
  let hop = 0;
  const fetchImpl = async () => {
    hop += 1;
    return hop === 1
      ? { status: 302, headers: { get: () => '/moved/real.mp3' } }
      : { status: 200, headers: { get: () => null } };
  };
  const final = await resolveFinalUrl('https://cdn.example.com/a/b.mp3', {
    fetchImpl,
    lookup: outside,
  });
  assert.equal(final, 'https://cdn.example.com/moved/real.mp3');
});

// A loop, or a chain long enough to be one. Following it forever is a bot that stops
// playing music and starts making requests.
test('a redirect loop ends rather than running forever', async () => {
  const fetchImpl = async () => ({
    status: 302,
    headers: { get: () => 'https://cdn.example.com/a.mp3' },
  });
  await assert.rejects(
    () => resolveFinalUrl('https://cdn.example.com/a.mp3', { fetchImpl, lookup: outside }),
    /too many redirects/i,
  );
});

test('a redirect to something that is not http at all is refused', async () => {
  const fetchImpl = async () => ({
    status: 302,
    headers: { get: () => 'file:///etc/passwd' },
  });
  await assert.rejects(
    () => resolveFinalUrl('https://cdn.example.com/a.mp3', { fetchImpl, lookup: outside }),
    /refused|not a url|public/i,
  );
});

test('publicUrl still refuses what it refused before', () => {
  assert.equal(publicUrl('file:///etc/passwd'), null);
  assert.equal(publicUrl('http://user:pass@cdn.example.com/a.mp3'), null);
  assert.equal(publicUrl('http://2130706433/a.mp3'), null);
  assert.equal(publicUrl('http://[::127.0.0.1]/a.mp3'), null);
  assert.equal(publicUrl('https://cdn.example.com/a.mp3'), 'https://cdn.example.com/a.mp3');
});

const outside = async () => [{ address: '93.184.216.34', family: 4 }];
