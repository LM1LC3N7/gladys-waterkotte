# -----------------------------------------------------------------------------
# Integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
# -----------------------------------------------------------------------------

FROM node:24-alpine

# dumb-init: handles signals (SIGTERM) correctly for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install the PROD dependencies first (better build cache). The lockfile is
# committed: strict `npm ci`, and no install script runs.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Then the integration code, its license and the third-party notices.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json LICENSE THIRD_PARTY_NOTICES.md ./

# The only writable location allowed at runtime: the stops not confirmed yet,
# the refusal fingerprint, the pause and the last attempt (never a password).
# Docker creates the volume with the owner of the image's /data: it must
# belong to `node`, and before VOLUME.
ENV NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
