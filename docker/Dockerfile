# taurus-agents base image
# Build:  docker build -t taurus-base docker/
# Usage:  set docker_image to "taurus-base" when creating an agent

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# ── Core utilities ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    file \
    git \
    curl \
    wget \
    jq \
    tree \
    vim \
    less \
    htop \
    unzip \
    zip \
    make \
    build-essential \
    sqlite3 \
    openssh-client \
    ca-certificates \
    ripgrep \
    fd-find \
    && ln -s $(which fdfind) /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# ── Python 3 + common libraries ──
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir \
    requests \
    beautifulsoup4 \
    lxml \
    pandas \
    numpy \
    matplotlib \
    pyyaml \
    flask \
    pytest \
    ruff \
    black \
    && curl -LsSf https://astral.sh/uv/install.sh | sh

# ── Node.js (LTS) ──
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g typescript prettier eslint

# ── Go ──
RUN curl -fsSL https://go.dev/dl/go1.24.3.linux-$(dpkg --print-architecture).tar.gz \
    | tar xz -C /usr/local
ENV PATH="/usr/local/go/bin:${PATH}"

# ── asdf version manager ──
RUN curl -fsSL https://github.com/asdf-vm/asdf/releases/download/v0.18.1/asdf-v0.18.1-linux-$(dpkg --print-architecture).tar.gz \
    | tar xz -C /usr/local/bin \
    && chmod +x /usr/local/bin/asdf

# ── Playwright + Chromium ──
RUN npm install -g playwright \
    && npx playwright install --with-deps chromium

# ── Browser CLI helper ──
COPY browser-cli.mjs /usr/local/lib/browser-cli.mjs
ENV NODE_PATH=/usr/lib/node_modules

WORKDIR /workspace
