#!/usr/bin/env bash
set -euo pipefail
export PATH="/opt/homebrew/bin:$PATH"
ssh -o BatchMode=yes air 'ssh -o BatchMode=yes root@192.168.15.244 "
killall -9 pocketjs-kindle 2>/dev/null || true
sh /mnt/us/pocketjs-dev/stop-runtime.sh 2>/dev/null || true
sleep 1
: > /mnt/us/pocketjs-dev/logs/runtime.log
nohup sh /mnt/us/pocketjs-dev/run-runtime.sh --js /mnt/us/pocketjs-dev/current/app.js --pak /mnt/us/pocketjs-dev/current/app.pak --fbink /mnt/us/pocketjs-dev/bin/fbink >/dev/null 2>&1 &
sleep 12
echo tap-logical 154 220 > /mnt/us/pocketjs-dev/run/cmd
sleep 6
echo tap-logical 154 220 > /mnt/us/pocketjs-dev/run/cmd
sleep 14
echo shot > /mnt/us/pocketjs-dev/run/cmd; sleep 2
cp /mnt/us/pocketjs-dev/run/shot.pgm /mnt/us/pocketjs-dev/run/fit-reader.pgm
grep remote_image /mnt/us/pocketjs-dev/logs/runtime.log | tail -5
grep manga.page /mnt/us/pocketjs-dev/logs/runtime.log | tail -5
ps | grep pocketjs-kindle | grep -v grep || echo DEAD
echo FIT_OK
"'
