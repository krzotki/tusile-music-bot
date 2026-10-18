# Tusile music bot

Plays openly licensed music in a [Tusile](https://tusile.com) voice channel.

```
/play                      a radio: openly licensed music, shuffled, in the voice
                           channel you are sitting in
/play query: lofi piano    that, instead
/radio station: jazz       one station, and stay on it
/queue  /skip  /stop
```

It plays where **you** are. The channel argument exists for queueing into a room you are
about to walk into, and is otherwise the question nobody wanted asked: the answer was
always "the one I am in".

It searches [Openverse](https://openverse.org) for Creative Commons audio, falling back to
[Jamendo](https://www.jamendo.com) and [ccMixter](https://ccmixter.org) when Openverse will
not answer, queues what it finds, and streams it into the channel. Everything it plays is openly licensed, so it names
the track, the artist and the licence every time, which is what those licences ask for.

It is also an example. If you are writing a Tusile bot and want to see the two parts that
are hardest to find your way around from the documentation alone, they are here in about
four hundred lines: **voice** (`player.js`) and **deferred interactions** (`commands.js`).
Fork it, change the search, keep the rest.

## Run it

You need Node 20 or newer and `ffmpeg` on the path.

1. **Make a bot.** In Tusile: Settings, Bots, New bot. You get a key and a secret, shown
   once.
2. **Install it** in a community, and tick the four permissions it asks for: view channel,
   send messages, connect, speak.
3. **Start it:**

```sh
npm install
CORE_SERVER_URL=https://api.tusile.com \
BOT_KEY=your-key \
BOT_SECRET=your-secret \
npm start
```

Or with Docker, which brings its own ffmpeg:

```sh
docker build -t tusile-music-bot .
docker run -e CORE_SERVER_URL=https://api.tusile.com -e BOT_KEY=... -e BOT_SECRET=... tusile-music-bot
```

**Optional: `JAMENDO_CLIENT_ID`.** Openverse sits behind Cloudflare, and some hosting
addresses get a challenge page instead of results (measured: our production boxes). The bot
then falls back on its own, and remembers the refusal for thirty minutes so it does not hit
a 403 on every search. With a free client id from
[devportal.jamendo.com](https://devportal.jamendo.com) the first fallback is Jamendo;
without one it is ccMixter, which needs no key. Both compose files pass it through, empty
by default.

There is no port to open and nothing to put behind a reverse proxy. The bot dials out to
every community it is installed in and nothing ever connects to it.

## What it plays, and what it will not

Openverse indexes Jamendo, Freesound, ccMixter and Wikimedia. That is a few hundred
thousand tracks, all openly licensed, and it is not the charts: searching for a song you
know by name will usually find nothing, and searching for a genre or a mood will find
plenty. `lofi piano`, `8 bit chiptune`, `ambient drone`, `upbeat folk guitar`.

This is on purpose. A bot that plays whatever is asked for is a bot that gets its owner a
letter, and an example that cannot be run honestly is not an example.

Anything over twenty minutes is skipped, so one twelve hour sleep loop cannot take the
evening, and each person may have five tracks waiting at a time.

**Credit is not optional.** Every licence here except CC0 requires attribution wherever the
work is used. The bot posts the track, the artist and the licence as each one starts. If
you fork this and take that out, you have made something you are not allowed to run.

## How it is put together

| File | What is in it |
|---|---|
| `search.js` | The sources, asked in order: Openverse, then Jamendo, then ccMixter. Swap them to change where music comes from. |
| `openverse.js` `jamendo.js` `ccmixter.js` | One source each, all answering in the same track shape, licence included. |
| `tracks.js` | What every source shares: duration limits, page size, which licences are playable. |
| `addresses.js` | Which addresses the bot will be pointed at. Read this before you swap `search.js`. |
| `stream.js` | Opens the connection with the address pinned, and hands ffmpeg the bytes. |
| `queue.js` | What is playing and what is next. Pure, so the rules are tested without a network. |
| `radio.js` | The stations, and which one and which page to ask for next. |
| `stations.js` | Keeps each station's next batch in its pocket, so a radio starts in seconds. |
| `decode.js` | ffmpeg: anything on the internet to the raw samples LiveKit takes. |
| `player.js` | One voice channel, one room, one queue draining into it. |
| `commands.js` | The five commands and what they say. |
| `index.js` | Wiring onto [`@tusile/bot`](https://www.npmjs.com/package/@tusile/bot). |

Three things in here are worth copying into your own bot:

**Defer anything slow.** An interaction has ten seconds to answer. Searching and joining a
room take longer than that on a bad day, so `/play` defers immediately and edits its answer
when it knows one. Without it the spinner gives up while the bot is doing exactly what it
was asked.

**`captureFrame` is the clock.** It returns when the audio source is ready for the next
10 ms, so feeding it in a loop plays in real time with no timer anywhere. It also means
`/skip` is a flag checked once per frame rather than anything to do with cancellation.

**Fetch it yourself if the url is not yours.** A url from a search index is a request made
from inside your network. Handing it to a tool that resolves the name again is a check you
cannot enforce; resolving once, inside the socket's own lookup, is one you can.

**Fetch what somebody will wait for before they ask.** Anonymous Openverse takes the
better part of forty seconds to answer a query it has not seen, and the first version
asked it while a person sat in an empty voice channel. The station list is fixed and known
at startup, so that batch is fetched then. Measured cold: 37.4s before, 1.9s after.

**Put the microphone down on every path out.** A bot left in a channel showing a live
microphone and playing nothing is what people report as "the bot is broken". `hangUp` runs
in a `finally` and swallows its own errors, because it runs after failures at least as
often as after successes.

## If you run this where internal services are reachable

The bot fetches whatever url the search index hands back, which makes every result a
request made from inside your network. So the bot does the fetching itself, rather than
letting ffmpeg do it:

- `addresses.js` refuses loopback, link local and private ranges, in every encoding the
  URL parser normalises, including the IPv4 addresses that can be carried inside an IPv6
  one. It refuses credentials in a url, and hands on the parsed form so nothing is parsed
  twice by two parsers that might disagree.
- `stream.js` opens the connection with `http.request`, passing its own `lookup`. That is
  the function the socket uses to turn a name into an address, so refusing inside it means
  **the address that was checked is the address that is connected to** — there is no second
  resolution for a rebinding attack to win. Redirects are followed here, each hop judged
  like the first.
- ffmpeg reads the bytes off a pipe and never opens a connection at all.

TLS is unaffected: `lookup` decides where the socket goes, and the certificate is still
checked against the hostname.

## Tests

```sh
npm test
```

186 of them. All but one need no network and no ffmpeg; that one runs ffmpeg to check it understands the arguments this bot builds, because no test that reads an array of strings can tell a real option from an invented one, and this file shipped one that reads perfectly and does not exist. They also run during `docker build`, so an
image cannot be built from code that does not pass.

## Licence

MIT. The music is not: each track carries its own Creative Commons licence, and the bot
tells you which.
