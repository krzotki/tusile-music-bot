import test from 'node:test';
import assert from 'node:assert/strict';

import { SEEDS, stationChoices, nextSeed, pickPage } from './radio.js';

/**
 * /play with nothing to say.
 *
 * Asked for directly: there should be a way to just have music on, without thinking of a
 * query. The catalogue is openly licensed music rather than a station, so the radio is a
 * shuffle over it that keeps itself topped up, not a stream somebody else is programming.
 */

test('the seeds are genres, not a playlist of one taste', () => {
  assert.ok(SEEDS.length >= 8, `${SEEDS.length} seeds is not a radio`);
  assert.equal(new Set(SEEDS).size, SEEDS.length, 'a seed is repeated');
});

// Two tracks in a row from the same seed is a station playing the same artist twice in a
// row, which is the most noticeable way a shuffle can look broken.
test('a seed never immediately follows itself', () => {
  for (const seed of SEEDS) {
    for (let i = 0; i < 50; i++) {
      assert.notEqual(nextSeed(seed), seed);
    }
  }
});

test('with nothing played yet it still picks something', () => {
  assert.ok(SEEDS.includes(nextSeed(null)));
});

/**
 * Openverse has no "random", so variety comes from asking for a different page.
 *
 * Without it the radio is the first few results of ten queries, forever: the same forty
 * tracks in the same order every evening, which is worse than a short playlist because it
 * pretends to be more.
 */
test('it asks for a page somewhere in the results, not always the first', () => {
  const pages = new Set();
  for (let i = 0; i < 200; i++) pages.add(pickPage(500, 5));
  assert.ok(pages.size > 3, `only saw pages ${[...pages].join(',')}`);
});

test('and never asks past the end of what there is', () => {
  for (let i = 0; i < 200; i++) {
    const page = pickPage(12, 5);
    assert.ok(page >= 1 && page <= 3, `page ${page} is past the end of 12 results`);
  }
});

// A seed nobody has anything for, or a search that found three tracks: page 1, not a
// division by zero or a page the API refuses.
/**
 * The page size has to be the one the request will use.
 *
 * Found live: with the radio computing pages as though one row fitted in each, a seed with
 * thirty eight results could be asked for page ten of twenty, find nothing, and end the
 * radio one track in.
 */
test('a seed with few results is never asked past its last page', () => {
  for (let i = 0; i < 300; i++) {
    const page = pickPage(38, 20);
    assert.ok(page >= 1 && page <= 2, `page ${page} of 20 is past the end of 38 results`);
  }
});

test('a thin or empty result set still asks for page one', () => {
  assert.equal(pickPage(0, 5), 1);
  assert.equal(pickPage(3, 5), 1);
});

/**
 * Choosing a station.
 *
 * Asked for: "we should be able to choose what radio to listen to (eg. jazz, lofi,
 * techno, rock)". /play with no query shuffles across everything, which is the right
 * default and the wrong answer to "put some jazz on".
 *
 * Offered as fixed choices rather than free text. The picker then shows the list, which is
 * the only way somebody learns that "chillhop" is a station and "the beatles" is not: this
 * catalogue is openly licensed music, so a station has to be something it actually has.
 * Every one of these was counted against Openverse before it went on the list.
 */
test('the stations are offered as choices, in the shape the picker takes', () => {
  const choices = stationChoices();
  assert.ok(choices.length >= 10, `${choices.length} stations is a thin radio`);
  for (const c of choices) {
    assert.ok(typeof c.name === 'string' && c.name.length > 0, JSON.stringify(c));
    assert.ok(typeof c.value === 'string' && c.value.length > 0, JSON.stringify(c));
  }
  assert.equal(new Set(choices.map((c) => c.value)).size, choices.length, 'a station repeats');
});

test('the ones that were asked for by name are there', () => {
  const values = stationChoices().map((c) => c.value);
  for (const want of ['jazz', 'lofi', 'techno', 'rock']) {
    assert.ok(values.includes(want), `${want} is not a station`);
  }
});

// The label is what a person reads in the dropdown, so it is not the raw query.
test('a station reads as a name rather than as a search term', () => {
  const chill = stationChoices().find((c) => c.value === 'acoustic guitar');
  assert.ok(chill, 'the acoustic station is gone');
  assert.equal(chill.name, 'Acoustic guitar');
});

// Every station must be a seed the mixed radio can also land on, or the two have drifted
// and a station exists that the shuffle has never heard of.
test('every station is one the mixed radio also knows', () => {
  for (const c of stationChoices()) {
    assert.ok(SEEDS.includes(c.value), `${c.value} is a station but not a seed`);
  }
});
