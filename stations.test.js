import test from 'node:test';
import assert from 'node:assert/strict';

import { createStationCache } from './stations.js';

/**
 * Why a radio keeps its stations in its pocket.
 *
 * Measured, cold: thirty seven seconds from /radio to the first sound, nearly all of it
 * one Openverse search. Anonymous Openverse is that slow for a query it has not seen, and
 * the bot was making that query while somebody sat in an empty voice channel.
 *
 * The station list is fixed and known at startup, so the batch somebody waits on does not
 * have to be fetched while they wait. The refills after it still go to the network, where
 * nobody is listening to the latency.
 */

const aTrack = (title) => ({ title, url: `https://x/${title}.mp3` });

test('a warmed station answers without touching the network', async () => {
  let calls = 0;
  const cache = createStationCache({
    stations: ['jazz'],
    search: async () => { calls += 1; return [aTrack('a'), aTrack('b')]; },
  });
  await cache.warm();
  assert.equal(calls, 1);

  const got = await cache.take('jazz');
  assert.equal(got.length, 2);
  assert.equal(calls, 1, 'taking from the cache went to the network');
});

// A station nobody warmed, or one whose warm failed: fall through rather than answer
// nothing. A slow radio beats a silent one.
test('a cold station is fetched rather than refused', async () => {
  let calls = 0;
  const cache = createStationCache({
    stations: ['jazz'],
    search: async () => { calls += 1; return [aTrack('a')]; },
  });
  const got = await cache.take('techno');
  assert.equal(got.length, 1);
  assert.equal(calls, 1);
});

// Taking is not peeking: two people asking for the same station in one evening should not
// get the same five tracks, and the cache has no business holding a batch it has served.
test('a batch is served once, then refetched', async () => {
  let calls = 0;
  const cache = createStationCache({
    stations: ['jazz'],
    search: async () => { calls += 1; return [aTrack(`round-${calls}`)]; },
  });
  await cache.warm();
  const first = await cache.take('jazz');
  const second = await cache.take('jazz');
  assert.notEqual(first[0].title, second[0].title);
});

// A warm that fails must not take the bot down with it, and must not poison the station.
test('a station that would not warm still works later', async () => {
  let fail = true;
  const cache = createStationCache({
    stations: ['jazz'],
    search: async () => {
      if (fail) throw new Error('openverse is down');
      return [aTrack('a')];
    },
  });
  await cache.warm();
  fail = false;
  const got = await cache.take('jazz');
  assert.equal(got.length, 1);
});

// Warming eighteen stations at once is eighteen simultaneous requests at a service that is
// already slow, from a bot that has just started and has nothing else to do. One at a time.
test('warming is one station at a time', async () => {
  let live = 0;
  let peak = 0;
  const cache = createStationCache({
    stations: ['a', 'b', 'c'],
    search: async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      return [aTrack('t')];
    },
  });
  await cache.warm();
  assert.equal(peak, 1, `${peak} searches were in flight at once`);
});

test('and it reports what it managed to warm', async () => {
  const cache = createStationCache({
    stations: ['a', 'b'],
    search: async (q) => (q === 'a' ? [aTrack('t')] : []),
  });
  const warmed = await cache.warm();
  assert.equal(warmed, 1);
});
