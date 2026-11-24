#!/usr/bin/env bash
set -euo pipefail

# The harness that launches the sandbox leaks GIT_CONFIG_* into it, which
# deterministically fails the relay agent-exec suites.
for name in $(env | sed -n 's/^\(GIT_CONFIG[A-Z0-9_]*\)=.*/\1/p'); do
  unset "$name"
done

cd /work

if [ "${QUIRKY_SANDBOX_SKIP_SOURCE:-0}" != "1" ]; then
  if [ -t 0 ]; then
    echo "quirky-test-sandbox: expected a source tar on stdin (run with -i)" >&2
    exit 2
  fi
  tar -x -f -
fi

# Composite tsconfigs cache errors from whichever checkout populated them last.
rm -f config/*.tsbuildinfo

# The source arrives as a plain tar, but suites that shell out to git need a real
# repository. Tree hashes are content-derived, so one synthetic commit satisfies them.
if [ "${QUIRKY_SANDBOX_SKIP_GIT:-0}" != "1" ] && [ ! -d .git ]; then
  git init -q .
  git add -A
  git -c user.name=runner -c user.email=runner@sandbox.invalid \
    commit -q -m 'sandbox snapshot' --no-verify
fi

baked="$(cat /home/runner/lockfile.sha256)"
current="$(sha256sum pnpm-lock.yaml | cut -d ' ' -f 1)"
if [ "$baked" != "$current" ]; then
  echo "quirky-test-sandbox: lockfile differs from the image; reinstalling" >&2
  pnpm install --no-frozen-lockfile --no-prefer-frozen-lockfile --ignore-scripts
  node config/scripts/ensure-native-runtime.mjs --runtime=node
fi

exec "$@"
