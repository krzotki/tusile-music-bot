import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

import { openAudioStream, pinnedLookup } from './stream.js';

/**
 * Closing the gap every earlier fix left open.
 *
 * The address rules, the redirect walk and the name resolution all judged a url and then
 * handed it to ffmpeg, which resolved the name again. Between the two lookups the answer
 * can change, which is DNS rebinding, and nothing in this process could make ffmpeg's
 * answer the same as ours. Three rounds of review said so and the README admitted it.
 *
 * So the bot does the fetching. Node's http.request takes a `lookup`, which is the function
 * the socket uses to get an address: validating inside it means the address that was
 * checked is the address that is connected to, with no second resolution to disagree.
 * ffmpeg reads the bytes off a pipe and never touches the network.
 */

/**
 * A request function in the shape node:http exports, recording what it was given.
 *
 * It calls `options.lookup` the way a real socket does, and fails the request when that
 * refuses. Without it the fake would happily connect to an address the pinned lookup was
 * built to reject, and the test proving that cannot happen would pass against a version
 * that never wired the lookup in at all.
 */
function fakeRequest({ responses }) {
  const calls = [];
  const impl = (options, onResponse) => {
    const req = new EventEmitter();
    req.end = () => {
      options.lookup(options.hostname, { all: true }, (err) => {
        if (err) {
          req.emit('error', err);
          return;
        }
        calls.push(options);
        const res = responses[calls.length - 1] ?? { statusCode: 200 };
        const stream = Readable.from([Buffer.from('audio')]);
        stream.statusCode = res.statusCode;
        stream.headers = res.headers || {};
        onResponse(stream);
      });
      return req;
    };
    req.destroy = () => { req.destroyed = true; return req; };
    return req;
  };
  return { impl, calls };
}

const publicAnswer = async () => [{ address: '93.184.216.34', family: 4 }];
const privateAnswer = async () => [{ address: '169.254.169.254', family: 4 }];

test('the address that was checked is the address the socket is given', async () => {
  const { impl, calls } = fakeRequest({ responses: [{ statusCode: 200 }] });
  await openAudioStream('https://cdn.example.com/a.mp3', {
    requestImpl: impl,
    lookup: publicAnswer,
  });

  // The whole point: a `lookup` reached the request, so the socket cannot resolve the name
  // a second time behind our back.
  assert.equal(typeof calls[0].lookup, 'function', 'the request was left to resolve for itself');
});

test('a name that resolves inside the network never gets connected to', async () => {
  const { impl, calls } = fakeRequest({ responses: [{ statusCode: 200 }] });
  await assert.rejects(
    () => openAudioStream('http://files.attacker.example/a.mp3', {
      requestImpl: impl,
      lookup: privateAnswer,
    }),
    /not a public address|169\.254/,
  );
  assert.equal(calls.length, 0, 'it opened the connection anyway');
});

/**
 * The lookup is the gate, so it has to refuse rather than merely report. A pinned lookup
 * that returned the address and let the caller decide would be the same two-step it
 * replaces, with the window simply made smaller.
 */
test('the pinned lookup itself refuses, rather than reporting back', async () => {
  const lookup = pinnedLookup(privateAnswer);
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      lookup('files.attacker.example', { all: true }, (err, value) =>
        (err ? reject(err) : resolve(value)));
    }),
    /not a public address/,
  );
});

test('and passes through the answers when they are all outside', async () => {
  const lookup = pinnedLookup(publicAnswer);
  const answers = await new Promise((resolve, reject) => {
    lookup('cdn.example.com', { all: true }, (err, value) => (err ? reject(err) : resolve(value)));
  });
  assert.deepEqual(answers, [{ address: '93.184.216.34', family: 4 }]);
});

test('a redirect is followed, and its destination judged the same way', async () => {
  const { impl, calls } = fakeRequest({
    responses: [
      { statusCode: 302, headers: { location: 'https://cdn2.example.com/real.mp3' } },
      { statusCode: 200 },
    ],
  });
  await openAudioStream('https://cdn.example.com/a.mp3', {
    requestImpl: impl,
    lookup: publicAnswer,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].hostname, 'cdn2.example.com');
});

/**
 * ccMixter answers 403 "Forbidden" to a request for an mp3 that carries no Referer, which
 * is hotlink protection rather than a block: measured, the same request with a Referer of
 * ccmixter.org answers 206. Each hop names its own origin, so nothing about where the
 * previous hop was leaks to the next host, and the checks on every hop are untouched.
 */
test('each hop names its own origin as the referer', async () => {
  const { impl, calls } = fakeRequest({
    responses: [
      { statusCode: 302, headers: { location: 'https://cdn2.example.com/real.mp3' } },
      { statusCode: 200 },
    ],
  });
  await openAudioStream('https://ccmixter.org/content/a/a.mp3', {
    requestImpl: impl,
    lookup: publicAnswer,
  });
  assert.equal(calls[0].headers.Referer, 'https://ccmixter.org/');
  assert.equal(calls[1].headers.Referer, 'https://cdn2.example.com/');
});

test('a redirect pointing inside the network is refused', async () => {
  const { impl } = fakeRequest({
    responses: [{ statusCode: 302, headers: { location: 'http://169.254.169.254/' } }],
  });
  await assert.rejects(
    () => openAudioStream('https://cdn.example.com/a.mp3', {
      requestImpl: impl,
      lookup: publicAnswer,
    }),
    /not a public address|refused/,
  );
});

test('a relative redirect is resolved against the url it came from', async () => {
  const { impl, calls } = fakeRequest({
    responses: [
      { statusCode: 302, headers: { location: '/moved/real.mp3' } },
      { statusCode: 200 },
    ],
  });
  await openAudioStream('https://cdn.example.com/a/b.mp3', {
    requestImpl: impl,
    lookup: publicAnswer,
  });
  assert.equal(calls[1].path, '/moved/real.mp3');
});

test('a redirect loop ends rather than running forever', async () => {
  const { impl } = fakeRequest({
    responses: Array.from({ length: 12 }, () => ({
      statusCode: 302,
      headers: { location: 'https://cdn.example.com/a.mp3' },
    })),
  });
  await assert.rejects(
    () => openAudioStream('https://cdn.example.com/a.mp3', {
      requestImpl: impl,
      lookup: publicAnswer,
    }),
    /too many redirects/i,
  );
});

/**
 * A 403 or a 404 is a track that will not play, and saying so is the difference between a
 * bot that reports a dead link and one that reports silence.
 */
test('a status that is not success is an error naming it', async () => {
  const { impl } = fakeRequest({ responses: [{ statusCode: 403 }] });
  await assert.rejects(
    () => openAudioStream('https://cdn.example.com/a.mp3', {
      requestImpl: impl,
      lookup: publicAnswer,
    }),
    /403/,
  );
});

test('a url that was never acceptable is refused before anything is opened', async () => {
  const { impl, calls } = fakeRequest({ responses: [{ statusCode: 200 }] });
  for (const url of ['file:///etc/passwd', 'http://user:pass@cdn.example.com/a.mp3']) {
    await assert.rejects(
      () => openAudioStream(url, { requestImpl: impl, lookup: publicAnswer }),
      /refused/,
    );
  }
  assert.equal(calls.length, 0);
});

test('what comes back is the body, ready to read', async () => {
  const { impl } = fakeRequest({ responses: [{ statusCode: 200 }] });
  const body = await openAudioStream('https://cdn.example.com/a.mp3', {
    requestImpl: impl,
    lookup: publicAnswer,
  });
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'audio');
});

/**
 * That node:http honours the `lookup` we give it, against a real socket.
 *
 * Every test above drives a fake request, which cannot tell whether Node would have used
 * our lookup at all. The whole fix rests on it doing so: if `lookup` were ignored on any
 * path, the socket would resolve the name itself and the pinning would be theatre that
 * passes its own tests. This file already shipped one argument that read perfectly and did
 * nothing, so "it looks right" is not evidence.
 *
 * Localhost only, no outside network. The first half proves Node routes the connection
 * through our function; the second proves refusing inside it stops the connection dead
 * rather than merely reporting afterwards.
 */
test('node really routes the connection through the lookup it is given', async () => {
  const { createServer, request } = await import('node:http');
  const server = createServer((_req, res) => { res.writeHead(200); res.end('reached'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();

  try {
    let askedFor = null;
    const res = await new Promise((ok, fail) => {
      const req = request({
        protocol: 'http:', hostname: 'definitely-not-real.invalid', port, path: '/',
        lookup: (host, _opts, cb) => {
          askedFor = host;
          cb(null, [{ address: '127.0.0.1', family: 4 }]);
        },
      }, ok);
      req.on('error', fail);
      req.end();
    });
    let body = '';
    for await (const chunk of res) body += chunk;

    assert.equal(askedFor, 'definitely-not-real.invalid', 'node resolved the name itself');
    assert.equal(body, 'reached', 'the lookup did not decide where the socket went');

    // And refusing in it is a refusal, not a report after the fact.
    let refused = null;
    try {
      await new Promise((ok, fail) => {
        const req = request({
          protocol: 'http:', hostname: 'definitely-not-real.invalid', port, path: '/',
          lookup: (_h, _o, cb) => cb(new Error('not a public address (127.0.0.1)')),
          // Its own socket. Without this the request reuses the one the half above left
          // in the keep-alive pool and never calls lookup, which is what this test found
          // the first time it ran, and why stream.js now passes agent: false.
          agent: false,
        }, ok);
        req.on('error', fail);
        req.end();
      });
    } catch (err) {
      refused = err.message;
    }
    assert.match(String(refused), /not a public address/, 'the connection went ahead anyway');
  } finally {
    server.close();
  }
});

/**
 * And the same thing through our own code: a name that would resolve inside is refused
 * before any socket is opened, with the real node:http rather than a fake.
 */
/**
 * Every connection gets a socket of its own, so every connection goes through the lookup.
 *
 * Node's global agent keeps connections alive and reuses them by host and port, and a
 * reused socket calls no lookup at all. The reuse is safe in itself, since the socket was
 * validated when it was opened, but "every connection was checked" should be true outright
 * rather than true once you have reasoned about the pool.
 */
test('every request gets its own socket rather than a pooled one', async () => {
  const { impl, calls } = fakeRequest({ responses: [{ statusCode: 200 }] });
  await openAudioStream('https://cdn.example.com/a.mp3', {
    requestImpl: impl,
    lookup: publicAnswer,
  });
  assert.equal(calls[0].agent, false, 'it can be handed a pooled connection');
});

test('and openAudioStream refuses a rebinding answer against the real http module', async () => {
  const { createServer } = await import('node:http');
  let hit = false;
  const server = createServer((_req, res) => { hit = true; res.writeHead(200); res.end('x'); });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address();

  try {
    await assert.rejects(
      () => openAudioStream(`http://cdn.example.com:${port}/a.mp3`, {
        // A public name whose answer points at the loopback server: rebinding, in one step.
        lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      }),
      /not a public address/,
    );
    assert.equal(hit, false, 'the request reached the loopback server anyway');
  } finally {
    server.close();
  }
});
