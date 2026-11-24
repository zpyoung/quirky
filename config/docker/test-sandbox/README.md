# Sandboxed test runs

Runs the suite in throwaway containers, locally or on a remote Docker host. Each shard gets
its own container fed the current working tree over stdin — nothing is mounted from the host,
so shards cannot see each other's temp files, git config, or build output.

## Remote host setup

The remote box needs Docker and an SSH account; the runner drives it over `DOCKER_HOST`, so
nothing but Docker has to be installed there.

```sh
ssh buildbox 'curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER'
docker context create buildbox --docker host=ssh://you@buildbox
```

`--docker-host` defaults to `$QUIRKY_SANDBOX_DOCKER_HOST`, so set that once instead of passing the
flag on every run. This checkout reads it from `.claude/settings.local.json`, which is machine-local
and untracked — a fresh clone has to set it before the runner reaches anything but the local daemon.

## Running

```sh
# full unit suite, 16 shards, 8 containers at a time
pnpm test:sandbox --shards=16 --jobs=8

# one shard, reusing the already-built image
pnpm test:sandbox --shards=16 --only=3

# the real-shell lane CI keeps out of the shards
pnpm test:sandbox --lane=shell

# Playwright/Electron lane (needs the host Docker socket for the ssh-docker specs)
pnpm test:sandbox --lane=e2e --shards=4 --docker-socket

# extra vitest arguments pass through after --
pnpm test:sandbox --shards=16 --only=1 -- --reporter=verbose
```

Running vitest directly is blocked by a `PreToolUse` hook — see the testing section in
[`AGENTS.md`](../../../AGENTS.md).

Per-shard logs land in `.quirky-sandbox-logs/`. `--node=26` builds the second Node version from
the CI matrix.

## Image lifecycle

The image tag is a hash of `package.json`, `pnpm-lock.yaml`, `config/patches`, `config/scripts`,
and this directory, so a dependency bump produces a new tag rather than reusing a stale
dependency tree. Dependencies, the native rebuild, and the Electron binary are baked in, so a
shard starts running tests immediately. If the working tree's lockfile drifts from the image's,
the entrypoint reinstalls before running rather than testing against the wrong tree.

## What the sandbox handles for you

- Unsets inherited `GIT_CONFIG_*`, which otherwise fails the relay agent-exec suites.
- Removes `config/*.tsbuildinfo`, which caches errors across checkouts sharing a tree.
- Sends only non-ignored files, so a stale local `out/` never reaches the container.
- Sets `QUIRKY_REQUIRE_FISH=1` on the shell lane, so a missing fish fails instead of skipping.
