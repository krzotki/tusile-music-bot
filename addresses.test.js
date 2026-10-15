import test from 'node:test';
import assert from 'node:assert/strict';

import { isPublicHost, publicUrl } from './addresses.js';

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

test('publicUrl still refuses what it refused before', () => {
  assert.equal(publicUrl('file:///etc/passwd'), null);
  assert.equal(publicUrl('http://user:pass@cdn.example.com/a.mp3'), null);
  assert.equal(publicUrl('http://2130706433/a.mp3'), null);
  assert.equal(publicUrl('http://[::127.0.0.1]/a.mp3'), null);
  assert.equal(publicUrl('https://cdn.example.com/a.mp3'), 'https://cdn.example.com/a.mp3');
});
