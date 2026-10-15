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
