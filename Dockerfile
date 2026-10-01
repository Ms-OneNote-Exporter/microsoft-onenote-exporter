# One image for all three steps.
#
# The three step packages each shipped their own image, and each carried its own
# Chromium: three builds, three pushes, three times the same ~1 GB of browser on
# disk, and three ways for the container's Node to disagree with the Node CI
# tested on. This image installs Playwright's Chromium once and serves login,
# check, logout, list and export from it.
#
# Node 24 LTS, pinned to a patch release rather than the floating `node:24-slim`,
# so two builds of the same commit produce the same base. Node 24 is what all four
# repositories' CI runs, so the container and the test suite agree.
FROM node:24.21.0-bookworm-slim

# ca-certificates for TLS.
#
# git is deliberately NOT installed. Nothing here fetches at build time: the step
# packages come from npm, and this file's own source is COPYed below, so the image
# contains the working tree it was built from rather than whatever was on `main`
# when the build ran.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies before source, so editing the code does not invalidate the
# expensive npm layer. `npm ci` installs exactly the lockfile and fails loudly if
# package.json and package-lock.json have drifted apart - `npm install` would
# quietly rewrite the lockfile inside the image.
#
# This is the layer that makes the image cheap to rebuild. Because the three step
# packages are pinned to exact versions, an npm layer cache hit means no Chromium
# layer is rebuilt either.
COPY package.json package-lock.json ./
RUN npm ci

# Chromium's system libraries (fonts, shared objects). Needs root for apt.
RUN npx playwright install-deps chromium

# The tool itself. The npm `files` list is irrelevant here: this is not a publish,
# it is the working tree.
COPY src/ ./src/
COPY entrypoint.sh ./
COPY package.json README.md NOTICE.md CHANGELOG.md LICENSE ./

# Browser binaries, installed as the unprivileged `node` user so the cache lives
# in that user's HOME and stays writable after we drop privileges.
#
# One Chromium for every step. The old images each ran their own `playwright
# install chromium`, and microsoft-onenote-list-notebooks also installed a
# distribution `chromium` from apt on top of that - a second browser, in the same
# image, that nothing used.
USER node
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN npx playwright install chromium

# The four loggers write to one directory (the umbrella sets
# ONENOTE_EXPORT_LOG_DIR before the step packages load, so their app.log lands
# here too rather than inside node_modules). The export step's default output
# directory is /app/output. Both live under /app, which is root-owned after the
# COPY above, so a non-root user could not create them and the logger's
# ensureDirSync would throw on startup. Pre-create just those two, owned by the
# runtime user - a recursive chown of node_modules is both slower and
# unnecessary, since nothing writes there.
USER root
RUN mkdir -p /app/logs /app/output && chown -R node:node /app/logs /app/output

USER node

# Chromium needs more than the default 64 MB of shared memory; without this it
# crashes on memory-heavy pages. `--shm-size` is a `docker run` flag, so
# start-container.sh passes it (along with --init to reap Chromium's zombies).
# Documented here so the requirement is not lost.
LABEL org.opencontainers.image.title="ms-onenote-exporter" \
      org.opencontainers.image.description="Sign in to Microsoft OneNote, list notebooks, and export one to Markdown" \
      org.opencontainers.image.source="https://github.com/Ms-OneNote-Exporter/ms-onenote-exporter" \
      org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/app/entrypoint.sh"]
