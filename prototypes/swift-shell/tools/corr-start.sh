#!/bin/sh
# usage: corr-start.sh <engine> [home]  — starts (or reuses) a daemon on <home> and launches the app
ENGINE=${1:-ghostty}
HOME_DIR=${2:-/tmp/qswift-corr}
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=${QUIRKY_TREE:-/Users/zpyoung/orca/workspaces/quirky/architecture}
export QUIRKY_HOME=$HOME_DIR
if ! [ -f "$HOME_DIR/runtime.json" ]; then
  (cd "$TREE" && nohup bun packages/daemon/src/main.ts >/tmp/qswift-corr.daemon.log 2>&1 &)
  sleep 3
fi
QSWIFT_ENGINE=$ENGINE QSWIFT_ADD_REPO=/tmp/qswift-repo QSWIFT_PANES=${QSWIFT_PANES:-2} nohup "$HERE/../.build/release/QuirkyShell" >/tmp/qswift-corr.app.log 2>&1 &
echo $! > /tmp/qswift-corr.app.pid
