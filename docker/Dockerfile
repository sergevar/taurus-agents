# taurus-agents base image
# Build:  docker build -t taurus-base docker/
# Usage:  set docker_image to "taurus-base" when creating an agent

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ── Core utilities + ripgrep + fd ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    file \
    git \
    curl \
    wget \
    jq \
    tree \
    ca-certificates \
    python3 \
    python3-pip \
    ripgrep \
    fd-find \
    && ln -s $(which fdfind) /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js (LTS) ──
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Playwright + Chromium ──
RUN npm install -g playwright \
    && npx playwright install --with-deps chromium

# ── Browser CLI helper ──
COPY browser-cli.mjs /usr/local/lib/browser-cli.mjs
ENV NODE_PATH=/usr/lib/node_modules

WORKDIR /workspace
