import test from 'node:test';
import assert from 'node:assert/strict';

import { Queue, totalDuration, clock } from './queue.js';

const track = (title, durationMs = 180000) => ({ title, durationMs });

test('the first track is playing now, the second is next', () => {
  const q = new Queue();
  assert.equal(q.add(track('one'), 'u1'), 1);
  assert.equal(q.add(track('two'), 'u1'), 2);
});

// Once something is playing it still counts, or the answer tells the second person they
// are first in a queue they are second in.
test('a track added while one is playing is told its real position', () => {
  const q = new Queue();
  q.add(track('one'), 'u1');
  q.next();
  assert.equal(q.add(track('two'), 'u2'), 2);
});

test('next hands them out in order and then runs out', () => {
  const q = new Queue();
  q.add(track('one'), 'u1');
  q.add(track('two'), 'u1');

  assert.equal(q.next().track.title, 'one');
  assert.equal(q.next().track.title, 'two');
  assert.equal(q.next(), null);
});

/**
 * Without a cap the first person to find /play owns the evening: twenty queued tracks is
 * two hours, and everybody else is told to wait.
 */
test('one person cannot fill the whole queue', () => {
  const q = new Queue({ perPersonLimit: 2 });
  q.add(track('one'), 'u1');
  q.add(track('two'), 'u1');
  assert.throws(() => q.add(track('three'), 'u1'), /already have 2/);
});

test('and somebody else is not held to their neighbour cap', () => {
  const q = new Queue({ perPersonLimit: 2 });
  q.add(track('one'), 'u1');
  q.add(track('two'), 'u1');
  assert.equal(q.add(track('three'), 'u2'), 3);
});

// Playing a track frees the slot it held. Otherwise the limit is "five per session"
// rather than "five waiting", and a long evening ends with the bot refusing everybody.
test('a track that has started playing no longer counts against its requester', () => {
  const q = new Queue({ perPersonLimit: 1 });
  q.add(track('one'), 'u1');
  q.next();
  assert.equal(q.add(track('two'), 'u1'), 2);
});

test('the list reads in the order it will be heard', () => {
  const q = new Queue();
  q.add(track('one'), 'u1');
  q.add(track('two'), 'u1');
  q.next();
  assert.deepEqual(q.list().map((e) => e.track.title), ['one', 'two']);
});

/**
 * Clearing what is playing is what makes stop final. The player reads `current` to decide
 * whether it is still meant to be feeding audio, so a stop that left it set would hand the
 * next track to a room already being torn down.
 */
test('clear forgets what is playing too', () => {
  const q = new Queue();
  q.add(track('one'), 'u1');
  q.next();
  q.clear();
  assert.equal(q.current, null);
  assert.equal(q.size, 0);
});

test('a total nobody can know is not guessed at', () => {
  assert.equal(totalDuration([{ track: track('a', 1000) }, { track: track('b', null) }]), null);
  assert.equal(totalDuration([{ track: track('a', 1000) }, { track: track('b', 2000) }]), 3000);
});

test('times read as minutes and seconds', () => {
  assert.equal(clock(187000), '3:07');
  assert.equal(clock(60000), '1:00');
  assert.equal(clock(0), '0:00');
  assert.equal(clock(null), '?');
});
