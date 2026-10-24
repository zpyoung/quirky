#!/bin/sh
# usage: correctness.sh <engine>  — vim live, close/reopen replay, and window-resize screenshots into results/
ENGINE=${1:-ghostty}
HERE=$(cd "$(dirname "$0")" && pwd)
HOME_DIR=/tmp/qswift-corr
OUT="$HERE/../results"
export QUIRKY_HOME=$HOME_DIR
rm -rf $HOME_DIR
seq 1 400 | awk '{printf "line %d: the quick brown fox jumps over the lazy dog\n", $1}' > /tmp/qswift-long.txt

launch() {
  "$HERE/corr-start.sh" "$ENGINE" "$HOME_DIR"
  sleep 7
  kill -INFO "$(cat /tmp/qswift-corr.app.pid)"
  sleep 1
  WIN=$(grep -o 'windowNumber=[0-9]*' /tmp/qswift-corr.app.log | tail -1 | cut -d= -f2)
}
shot() { screencapture -x -o -l "$WIN" "$OUT/$ENGINE-$1.png"; }
front() { osascript -e "tell application \"System Events\" to set frontmost of (first process whose unix id is $(cat /tmp/qswift-corr.app.pid)) to true"; sleep 1; }
type_text() { osascript -e "tell application \"System Events\" to keystroke \"$1\""; }
press_return() { osascript -e 'tell application "System Events" to key code 36'; }

launch
front; type_text "vim /tmp/qswift-long.txt"; press_return; sleep 2
type_text "jjjjj"; sleep 1
shot vim-live
kill "$(cat /tmp/qswift-corr.app.pid)"; sleep 2
launch
shot vim-reopen
kill -USR2 "$(cat /tmp/qswift-corr.app.pid)"; sleep 2
shot vim-resized-narrow
kill -USR2 "$(cat /tmp/qswift-corr.app.pid)"; sleep 2
shot vim-resized-wide
front; type_text ":q"; press_return; sleep 1
shot vim-quit
kill "$(cat /tmp/qswift-corr.app.pid)" 2>/dev/null
PTY=$(cat $HOME_DIR/pty.pid 2>/dev/null)
DPID=$(python3 -c "import json;print(json.load(open('$HOME_DIR/runtime.json'))['pid'])" 2>/dev/null)
for p in $(pgrep -P "$PTY" 2>/dev/null); do kill "$p" 2>/dev/null; done
kill $PTY $DPID 2>/dev/null
sleep 1
rm -rf $HOME_DIR /tmp/qswift-corr.*
