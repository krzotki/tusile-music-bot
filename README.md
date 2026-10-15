# Tusile music bot

Plays openly licensed music in a [Tusile](https://tusile.com) voice channel.

```
/play query: lofi piano   channel: General
/queue
/skip
/stop
```

It searches [Openverse](https://openverse.org) for Creative Commons audio, queues what it
finds, and streams it into the channel. Everything it plays is openly licensed, so it names
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
| `search.js` | Openverse. No API key, no account. Swap this file to change where music comes from. |
| `queue.js` | What is playing and what is next. Pure, so the rules are tested without a network. |
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

**Put the microphone down on every path out.** A bot left in a channel showing a live
microphone and playing nothing is what people report as "the bot is broken". `hangUp` runs
in a `finally` and swallows its own errors, because it runs after failures at least as
often as after successes.

## Tests

```sh
npm test
```

73 of them, no network and no ffmpeg needed. They also run during `docker build`, so an
image cannot be built from code that does not pass.

## Licence

MIT. The music is not: each track carries its own Creative Commons licence, and the bot
tells you which.
