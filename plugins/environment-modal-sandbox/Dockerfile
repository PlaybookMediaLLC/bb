# Debian with Node.js and npm, pinned for reproducible machine images.
FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# Git/GitHub access, HTTP and JSON tools, fast search, and native build support.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bubblewrap \
        ca-certificates \
        curl \
        git \
        gh \
        jq \
        ripgrep \
        procps \
        build-essential \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Package manager and coding agents. Versions match the supported BB providers.
RUN npm install -g \
        pnpm@9.15.0 \
        @earendil-works/pi-coding-agent@0.84.0 \
        @openai/codex@0.153.4 \
        @anthropic-ai/claude-code@2.1.263 \
    && npm cache clean --force

# Run agents as an unprivileged user with a writable home directory.
# BB installs its daemon on demand during bootstrap; it is not baked into this image.
USER node
WORKDIR /home/node
