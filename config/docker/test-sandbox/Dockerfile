# syntax=docker/dockerfile:1.7
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ARG NODE_MAJOR=24
ARG PNPM_VERSION=12.0.0
ARG NODE_GYP_VERSION=11.5.0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    dbus-x11 \
    git \
    gnupg \
    jq \
    libasound2t64 \
    libatk-bridge2.0-0 \
    libatspi2.0-0 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxss1 \
    openssh-client \
    procps \
    python3 \
    software-properties-common \
    unzip \
    xauth \
    xvfb \
    xz-utils \
    zsh \
  && rm -rf /var/lib/apt/lists/*

# fish 4+ only: DECSET 2031 arming lives in the 4.0 Rust tty_handoff, and noble ships 3.7.
RUN add-apt-repository -y ppa:fish-shell/release-4 \
  && apt-get update \
  && apt-get install -y --no-install-recommends fish \
  && rm -rf /var/lib/apt/lists/*

# The git-compatibility matrix and the ssh-docker e2e lanes shell out to docker themselves.
RUN install -m 0755 -d /etc/apt/keyrings \
  && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
  && chmod a+r /etc/apt/keyrings/docker.asc \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends docker-ce-cli docker-buildx-plugin \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  version="$(curl -fsSL https://nodejs.org/dist/index.json \
    | jq -r --arg prefix "v${NODE_MAJOR}." 'map(select(.version | startswith($prefix))) | .[0].version')"; \
  case "$(dpkg --print-architecture)" in \
    amd64) arch=x64 ;; \
    arm64) arch=arm64 ;; \
    *) echo "unsupported architecture" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://nodejs.org/dist/${version}/node-${version}-linux-${arch}.tar.xz" -o /tmp/node.tar.xz; \
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md; \
  rm /tmp/node.tar.xz; \
  npm install -g "pnpm@${PNPM_VERSION}" "node-gyp@${NODE_GYP_VERSION}"

# pnpm's bundled gyp_main.py is not executable, so native rebuilds need the standalone node-gyp.
ENV npm_config_node_gyp=/usr/local/lib/node_modules/node-gyp/bin/node-gyp.js

COPY --chmod=0755 config/docker/test-sandbox/entrypoint.sh /usr/local/bin/quirky-test-sandbox

# Tests that induce fs errors with chmod 0555 need a user that DAC actually stops;
# as root those writes succeed. Named for CI's user because diagnostic redaction
# rewrites the username, and a name appearing in fixture text corrupts the expected output.
RUN useradd --create-home --shell /bin/bash runner \
  && mkdir -p /work \
  && chown runner:runner /work

USER runner
WORKDIR /work

# Why: the image is a throwaway per-shard install, so it keeps a project-local node_modules as CI does.
ENV QUIRKY_PNPM_GLOBAL_VIRTUAL_STORE=0

COPY --chown=runner:runner package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chown=runner:runner config/pnpmfile.cjs ./config/pnpmfile.cjs
COPY --chown=runner:runner config/patches ./config/patches
# Why: pnpm-workspace.yaml lists these packages, so install fails without their manifests.
COPY --chown=runner:runner src/packages ./src/packages
COPY --chown=runner:runner native/windows-registry/package.json ./native/windows-registry/package.json
COPY --chown=runner:runner native/windows-security/package.json ./native/windows-security/package.json

RUN pnpm install --no-frozen-lockfile --no-prefer-frozen-lockfile --ignore-scripts

COPY --chown=runner:runner config/scripts ./config/scripts
# Why: install-electron-package-binary.mjs re-exports its zip extractor from src/shared.
COPY --chown=runner:runner src/shared/zip-extractor-command.ts ./src/shared/zip-extractor-command.ts

# Why build:packages first: ensure-native-runtime.mjs imports @quirky/process-host's dist output.
RUN pnpm run build:packages \
  && node config/scripts/ensure-native-runtime.mjs --runtime=node \
  && node config/scripts/install-electron-package-binary.mjs \
  && sha256sum pnpm-lock.yaml | cut -d ' ' -f 1 > /home/runner/lockfile.sha256

ENTRYPOINT ["/usr/local/bin/quirky-test-sandbox"]
CMD ["pnpm", "exec", "vitest", "run", "--config", "config/vitest.config.ts"]
