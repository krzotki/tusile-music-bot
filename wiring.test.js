import test from 'node:test';
import assert from 'node:assert/strict';

import { wire, runCommand, Sessions, contextSearch } from './index.js';
import { definitions } from './commands.js';

/**
 * That the pieces are actually joined up.
 *
 * Every test in the other files builds its own context and calls `handle` directly, so all
 * of them would pass with a command defined and never registered, or an answer built and
 * never sent. That is not hypothetical: it is the shape of two bugs shipped in this
 * codebase in the last fortnight, both with green suites.
 */

function fakeBot() {
  const commands = [];
  const handlers = new Map();
  const listeners = new Map();
  return {
    commands,
    handlers,
    listeners,
    command: (definition, handler) => {
      commands.push(definition);
      handlers.set(definition.name, handler);
    },
    on: (event, fn) => listeners.set(event, fn),
  };
}

function fakeInteraction(over = {}) {
  const sent = [];
  return {
    sent,
    i: {
      server: { serverId: 's-1', send: async (c, m) => sent.push({ send: m }) },
      channelId: 'c-1',
      userId: 'u-1',
      options: {},
      defer: async () => sent.push({ defer: true }),
      editReply: async (content) => sent.push({ edit: content }),
      reply: async (body, opts) => sent.push({ reply: body.content, ephemeral: opts?.ephemeral }),
      ...over,
    },
  };
}

test('every command this bot defines is registered on the bot', () => {
  const bot = fakeBot();
  wire(bot);
  assert.deepEqual(
    bot.commands.map((c) => c.name).sort(),
    definitions.map((d) => d.name).sort(),
  );
});

test('an answer that was built is actually sent', async () => {
  const bot = fakeBot();
  wire(bot);
  const { i, sent } = fakeInteraction();

  await bot.handlers.get('queue')(i);
  assert.equal(sent.length, 1);
  assert.match(sent[0].reply, /Nothing is playing/);
  assert.equal(sent[0].ephemeral, true, 'a queue listing went to the whole channel');
});

test('a command that answers over its own deferred interaction sends no second reply', async () => {
  const sessions = new Sessions();
  const { i, sent } = fakeInteraction({ options: { query: 'lofi', channel: 'v1' } });
  await runCommand('play', i, sessions, { search: async () => [] });

  assert.ok(sent.some((s) => s.defer));
  assert.ok(sent.some((s) => s.edit), 'nothing was delivered on the deferred interaction');
  assert.equal(sent.filter((s) => s.reply).length, 0, 'it replied twice');
});

/**
 * Keyed by community and channel together. The bot is installed in several places and
 * there is no reason two communities cannot be listening to different things, which keying
 * by channel alone would have made impossible in a way nobody would notice until the
 * second community tried.
 */
test('two communities can play different things in channels with the same id', () => {
  const sessions = new Sessions({ connect: async () => ({}) });
  const server = { serverId: 'a' };
  const a = sessions.for('a', 'v1', { server });
  const b = sessions.for('b', 'v1', { server });
  assert.notEqual(a, b);
});

test('asking twice for the same channel gets the same session', () => {
  const sessions = new Sessions();
  const server = { serverId: 'a' };
  assert.equal(sessions.for('a', 'v1', { server }), sessions.for('a', 'v1', { server }));
});

// `stopped` is permanent, so a stopped session must be replaced rather than handed back,
// or /play after /stop answers "this session has ended" forever.
test('a stopped session is replaced by a fresh one', () => {
  const sessions = new Sessions();
  const server = { serverId: 'a' };
  const first = sessions.for('a', 'v1', { server });
  first.stopped = true;
  assert.notEqual(sessions.for('a', 'v1', { server }), first);
});

test('a community the bot is removed from has its sessions let go of', async () => {
  const bot = fakeBot();
  const sessions = wire(bot);
  const stopped = [];
  sessions.map.set('s-9:v1', { stop: async () => stopped.push(true), stopped: false });

  bot.listeners.get('left')('s-9');
  await new Promise((r) => setImmediate(r));

  assert.equal(sessions.map.size, 0);
  assert.equal(stopped.length, 1, 'it left the community still holding a microphone');
});

// A silent bot and a bot talking to the box a community has moved away from look identical
// from outside, which cost a day in production on 2026-10-07.
test('connecting says which address it is talking to', () => {
  const bot = fakeBot();
  wire(bot);
  const lines = [];
  const real = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    bot.listeners.get('ready')({ name: 'DJ' }, { serverId: 's-1', apiUrl: 'https://x.tusile.com' });
  } finally {
    console.log = real;
  }
  assert.match(lines.join('\n'), /https:\/\/x\.tusile\.com/);
});

/**
 * The options reach the real search.
 *
 * Found in production, by the radio answering "I could not find anything to play just
 * now" every single time. The context's search was `(query) => search(query)`, which
 * drops every argument after the first, so `withTotal` never arrived, the total read as
 * nothing, and the batch the radio was handed was undefined.
 *
 * Every test of the radio passed, because every one of them supplied a fake search that
 * honoured the options the real wiring was throwing away. That is the shape of the bug:
 * the fake was more capable than the thing it stood in for.
 */
test('the context search passes its options through, not just the query', async () => {
  const seen = [];
  const sessions = new Sessions();
  const { i } = fakeInteraction({ options: {} });
  i.userVoiceChannelId = 'v1';

  await runCommand('play', i, sessions, {
    // An empty pocket, so this falls through to the search being measured rather than to
    // the real warmed cache, which would go to Openverse and take half a minute.
    stations: { take: async () => [] },
    search: async (query, opts) => {
      seen.push({ query, opts });
      return opts?.withTotal ? { tracks: [], total: 0 } : [];
    },
  });

  assert.ok(seen.length > 0, 'it never searched');
  assert.ok(
    seen.some((s) => s.opts && s.opts.withTotal === true),
    `the radio asked without withTotal: ${JSON.stringify(seen)}`,
  );
});

// And with nothing injected, it is the real search rather than a wrapper around it. A
// wrapper is the only way an argument can go missing, and one did.
test('with no deps the context search is the module itself', async () => {
  const { search } = await import('./search.js');
  assert.equal(contextSearch({}), search);
  assert.equal(contextSearch(), search);
});
