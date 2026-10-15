/**
 * Which addresses this bot is willing to be pointed at.
 *
 * A url from a search index is a request this bot makes, from inside wherever it runs. A
 * cloud metadata endpoint, an admin page on localhost, a service on the private network:
 * ffmpeg would fetch any of them, find no audio, and move on, but the request was still
 * made from behind the firewall. A third party index describing files uploaded by
 * strangers does not get to choose which addresses this bot connects to.
 *
 * Its own module because both halves of the bot need it and neither should import the
 * other: search.js judges the url before offering a track, and decode.js checks again, with
 * a name resolution, before starting ffmpeg. The README invites people to replace search.js
 * with their own, and this is what still holds when they do.
 *
 * None of this closes DNS rebinding. ffmpeg resolves the name again when it connects, and
 * nothing in this process can make that answer the same one it gave here. A bot on a
 * network with reachable internal services wants egress rules; this is the floor, not the
 * answer.
 */

/**
 * Whether a host, as a literal address or a name, is one we will connect to.
 *
 * Written against a parsed hostname, never against url text. Every numeric form of
 * 127.0.0.1 (`2130706433`, `0177.0.0.1`, `0x7f000001`, `127.1`) is one the WHATWG parser
 * normalises to dotted decimal, so a check on the parsed value gets them all and a check
 * on the string gets none of them.
 *
 * A name that is not an address literal passes here. It cannot be judged without a
 * resolution, which is `resolvesOutside`.
 */
function isPublicHost(host) {
  const name = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!name) return false;
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.internal')) {
    return false;
  }
  if (name.includes(':')) return isPublicIPv6(name);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name)) return isPublicIPv4(name);
  return true;
}

function isPublicIPv4(name) {
  const [a, b] = name.split('.').map(Number);
  if (a === 0 || a === 127 || a === 10) return false;
  if (a === 169 && b === 254) return false; // link local, and the cloud metadata address
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier grade NAT
  if (a >= 224) return false; // multicast and above
  return true;
}

function isPublicIPv6(name) {
  if (name === '::1' || name === '::') return false;
  // Unique local (fc00::/7) and link local (fe80::/10).
  if (/^f[cd][0-9a-f]{0,2}:/.test(name) || /^fe[89ab][0-9a-f]?:/.test(name)) return false;
  // IPv4 mapped, in both the readable form and the one the parser normalises it to:
  // [::ffff:127.0.0.1] becomes [::ffff:7f00:1], which no v4 rule would ever match.
  const mapped = /^::ffff:(.+)$/.exec(name);
  if (mapped) {
    const rest = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(rest)) return isPublicIPv4(rest);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const packed = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
      const dotted = [24, 16, 8, 0].map((s) => (packed >>> s) & 255).join('.');
      return isPublicIPv4(dotted);
    }
    return false;
  }
  return true;
}

/**
 * The url to hand on, normalised, or null if we will not fetch it.
 *
 * Returning the parsed form rather than a yes or no is the point. Two parsers reading one
 * string is where this kind of filter usually fails: whatever subtlety Node's URL resolves
 * one way and ffmpeg's resolves another is a gap by construction. Handing on `href` means
 * ffmpeg is given the thing that was judged, with no second parse of the original text.
 *
 * Credentials are refused rather than adjudicated. They are the oldest way of writing a url
 * that reads as somewhere it is not, the two parsers need not agree about them, and nothing
 * in an openly licensed music index has a password in it.
 */
function publicUrl(raw) {
  if (typeof raw !== 'string') return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (!isPublicHost(url.hostname)) return null;
  // ffmpeg has no use for a fragment, and it is one more thing for two parsers to
  // disagree about: `http://127.0.0.1#@example.com/` is a url whose host depends on who is
  // reading it.
  url.hash = '';
  return url.href;
}

/**
 * Whether every address a hostname resolves to is one we will connect to.
 *
 * `lookup` is injected so the tests never touch DNS. Every answer has to pass: a name
 * resolving to one public and one private address is the shape of the attack rather than
 * an accident.
 */
async function resolvesOutside(host, lookup) {
  const name = String(host || '').replace(/^\[|\]$/g, '');
  // An address literal has already been judged by isPublicHost, and asking DNS about one
  // is a round trip to be told what it says on it.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) {
    return { ok: isPublicHost(name), address: name };
  }
  const answers = await lookup(name, { all: true });
  for (const answer of answers) {
    if (!isPublicHost(answer.address)) return { ok: false, address: answer.address };
  }
  return { ok: true, address: answers[0]?.address };
}

export { isPublicHost, publicUrl, resolvesOutside };
