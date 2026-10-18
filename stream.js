/**
 * Fetching the audio ourselves, so that the address we checked is the address we reach.
 *
 * Everything before this judged a url and then handed it to ffmpeg, which resolved the
 * name again when it connected. Between the two lookups the answer can change, which is
 * DNS rebinding, and no amount of checking on this side could make ffmpeg's answer match
 * ours. Three rounds of review said so and the README admitted it.
 *
 * The fix is to stop having two lookups. `http.request` takes a `lookup`, which is the
 * function the socket itself uses to turn a name into an address: refusing inside it means
 * the address that was checked is the address that is connected to, with nothing in
 * between. ffmpeg then reads bytes off a pipe and never touches the network at all, which
 * also retires the protocol whitelist, the redirect flag and every other way of asking it
 * politely not to fetch things.
 *
 * TLS is unaffected. `lookup` decides where the socket goes; the certificate is still
 * checked against the hostname, and SNI still carries it.
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';

import { isPublicHost, publicUrl } from './addresses.js';

/** Enough hops for a CDN that likes them, few enough that a loop ends. */
const MAX_HOPS = 5;

/**
 * A `lookup` for net.connect that refuses rather than reports.
 *
 * It has to refuse here, in the callback the socket is waiting on. A version that resolved
 * the name, handed the address back and let the caller decide would be the same two-step
 * it replaces, with the window merely made smaller.
 *
 * Every answer is checked, not the first: a name resolving to one public and one private
 * address is the shape of the attack rather than an accident. Node may call this with
 * `all: false`, in which case it wants one address and three arguments back.
 */
function pinnedLookup(resolver = defaultResolver) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};

    Promise.resolve(resolver(hostname, { all: true, family: opts.family }))
      .then((answers) => {
        const list = Array.isArray(answers) ? answers : [answers];
        if (list.length === 0) {
          done(new Error(`${hostname} resolved to nothing`));
          return;
        }
        for (const answer of list) {
          if (!isPublicHost(answer.address)) {
            done(new Error(`${hostname} is not a public address (${answer.address})`));
            return;
          }
        }
        if (opts.all) done(null, list);
        else done(null, list[0].address, list[0].family);
      })
      .catch((err) => done(err));
  };
}

function defaultResolver(hostname, options) {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, options, (err, answers) => (err ? reject(err) : resolve(answers)));
  });
}

/**
 * Open the audio, following redirects, and hand back the body to read.
 *
 * Every hop is judged the same way as the first: the url by `publicUrl`, the address by the
 * pinned lookup inside the connection. A redirect is the one place a request that started
 * somewhere reasonable ends up somewhere nobody looked at.
 *
 * `requestImpl` and `lookup` are injected so the tests need no network and no DNS.
 */
async function openAudioStream(raw, { requestImpl, lookup, maxHops = MAX_HOPS, signal } = {}) {
  let current = publicUrl(raw);
  if (current === null) throw new Error(`refused: ${raw}`);

  const resolve = pinnedLookup(lookup || defaultResolver);

  for (let hop = 0; hop <= maxHops; hop++) {
    const url = new URL(current);
    const send = requestImpl || (url.protocol === 'https:' ? httpsRequest : httpRequest);

    const res = await new Promise((ok, fail) => {
      const req = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          lookup: resolve,
          // Its own socket, every time.
          //
          // Node's global agent keeps connections alive and reuses them by host and port,
          // and a reused socket does not call `lookup` at all: measured, one lookup for two
          // requests. That reuse is not itself a hole, because the socket it hands back was
          // validated when it was opened. But it makes "every connection went through the
          // check" a claim you have to reason about the pool to believe, and the next person
          // to read this should not have to. A fresh socket makes it true outright.
          //
          // Nothing is lost: each of these is one long audio stream, so there is no second
          // request to amortise a kept connection over.
          agent: false,
          signal,
          headers: {
            'User-Agent': 'tusile-music-bot (https://github.com/krzotki/tusile-music-bot)',
            Accept: '*/*',
            // This hop's own origin, never the previous hop's, so nothing about where the
            // request came from reaches the next host. ccMixter's mp3s answer 403 to a
            // request with no Referer at all (hotlink protection, measured); with one, 206.
            Referer: `${url.origin}/`,
          },
        },
        ok,
      );
      req.on('error', fail);
      req.end();
    });

    if (res.statusCode >= 300 && res.statusCode <= 399 && res.headers.location) {
      // Nothing here wants the body of a redirect, and an unread response holds the socket.
      res.resume();
      // Resolved against the url it came from: a bare path is legal and common, and
      // resolving one against the wrong base is another way to end up somewhere unjudged.
      const next = publicUrl(new URL(res.headers.location, current).href);
      if (next === null) throw new Error(`refused redirect to ${res.headers.location}`);
      current = next;
      continue;
    }

    if (res.statusCode < 200 || res.statusCode > 299) {
      res.resume();
      throw new Error(`${current} answered ${res.statusCode}`);
    }
    return res;
  }
  throw new Error(`too many redirects from ${raw}`);
}

export { openAudioStream, pinnedLookup, MAX_HOPS };
