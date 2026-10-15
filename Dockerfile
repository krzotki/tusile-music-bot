# A music bot: a long-lived process that dials out and never listens.
#
# No EXPOSE and no ports, deliberately. The bot opens a WebSocket to each community it is
# installed on and answers over HTTPS; nothing ever connects to it.
#
# Debian rather than Alpine for two reasons, both of which produce a bot that starts
# perfectly and then fails the first time somebody asks for music. @livekit/rtc-node is a
# native module with prebuilt binaries for linux-x64-gnu and linux-arm64-gnu only, so on
# musl there is nothing to load. And ffmpeg on Alpine is built against musl too.
FROM node:22-slim

# ffmpeg decodes whatever the internet hands back into the raw samples LiveKit takes, and
# reads the url itself so nothing is ever written to disk.
#
# ca-certificates because node:22-slim has no /etc/ssl at all. Node carries its own copy of
# the Mozilla root list so every HTTPS call works without this, but @livekit/rtc-node is
# Rust and its TLS reads the operating system trust store: without a bundle the bot starts,
# connects, searches, and then fails the moment it tries to join a room, with "no native
# root CA certificates found". The `test -s` makes a future base image that ships no bundle
# fail the build rather than ship a bot that can do everything except the one thing.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && test -s /etc/ssl/certs/ca-certificates.crt \
 && ffmpeg -version > /dev/null

WORKDIR /app

# Dependencies first, so a change to the bot does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.js ./

# Runs unprivileged. The node images ship a `node` user for this.
USER node

# The tests run at build time, so an image cannot be produced from code that does not pass
# them. They need no network and no ffmpeg.
RUN node --test

CMD ["node", "bin.js"]
