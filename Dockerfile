# Single image carrying every runtime this project needs:
#   Node    - bot, Activity host, voice transmission
#   Python  - the analyser (librosa)
#   ffmpeg  - decodes provider audio for both Discord and librosa
#   yt-dlp  - YouTube audio extraction
#
# Build context is the repository root, above activity/ and visualcore/.
FROM node:22-bookworm-slim

# ffmpeg is required twice over: @discordjs/voice transcodes through it, and
# soundfile cannot decode AAC so librosa falls back to audioread, which shells
# out to it.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY activity/package*.json ./activity/
RUN cd activity && npm ci

COPY visualcore/requirements.txt ./visualcore/
# yt-dlp from pip rather than apt: the Debian package lags badly, and YouTube
# extraction breaks whenever it falls behind.
RUN pip3 install --no-cache-dir --break-system-packages \
      -r visualcore/requirements.txt yt-dlp

COPY visualcore ./visualcore
COPY activity ./activity

# Vite inlines VITE_-prefixed variables at BUILD time and reads them from the
# process environment. Since .env is dockerignored, this must arrive as a build
# argument or the client ships with an undefined client ID and every Discord
# sign-in fails.
ARG VITE_DISCORD_CLIENT_ID
ENV VITE_DISCORD_CLIENT_ID=$VITE_DISCORD_CLIENT_ID
RUN test -n "$VITE_DISCORD_CLIENT_ID" \
      || (echo "ERROR: VITE_DISCORD_CLIENT_ID build arg is required" && exit 1) \
    && cd activity && npm run build \
    && npm prune --omit=dev

# Warm numba's cache during the build so the first analysis in production does
# not pay ~35 seconds of JIT compilation.
ENV PYTHONPATH=/app/visualcore/src
RUN python3 -c "import visualcore, librosa, numpy" || true

ENV PYTHON_BIN=python3 \
    VISUALCORE_PATH=/app/visualcore/src \
    CLIENT_DIR=client/dist \
    CACHE_DIR=/data/cache \
    YTDLP_BIN=yt-dlp \
    PORT=3000

WORKDIR /app/activity
EXPOSE 3000
CMD ["node", "server.js"]
