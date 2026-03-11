# Container Environment

This is your workspace inside a Docker container. Key things to know:

## Persistent vs ephemeral

- `/workspace` is mounted on a persistent volume — files here survive container restarts.
- Everything else (system packages, global npm/pip installs, /root, /tmp) is **ephemeral** and will be lost if the container is recreated.

## If you need to install something

For tools/binaries that must persist across restarts, install them into `/workspace/.tools` and add it to PATH:

```bash
export PATH="/workspace/.tools/bin:$PATH"
pip install --target=/workspace/.tools/python <package>
```

For quick experiments where persistence doesn't matter, just `apt-get install` or `pip install` normally.

## Pre-installed tools

- **Python 3** + uv, requests, beautifulsoup4, pandas, numpy, matplotlib, flask, pytest, ruff, black
- **Node.js 22** + typescript, prettier, eslint, playwright (with Chromium)
- **Go 1.24**
- **asdf** version manager — install additional runtimes on demand (`asdf plugin add rust && asdf install rust latest`)
- **System**: git, curl, wget, jq, ripgrep (rg), fd, vim, make, gcc/g++, sqlite3, zip/unzip
