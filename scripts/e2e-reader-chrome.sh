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
# open manga + chapter
echo tap-logical 154 220 > /mnt/us/pocketjs-dev/run/cmd
sleep 6
echo tap-logical 154 220 > /mnt/us/pocketjs-dev/run/cmd
sleep 14
# default reader (chrome hidden)
echo shot > /mnt/us/pocketjs-dev/run/cmd; sleep 2
cp /mnt/us/pocketjs-dev/run/shot.pgm /mnt/us/pocketjs-dev/run/r1-clean.pgm
# center tap -> show chrome
echo tap-logical 154 200 > /mnt/us/pocketjs-dev/run/cmd
sleep 2
echo shot > /mnt/us/pocketjs-dev/run/cmd; sleep 2
cp /mnt/us/pocketjs-dev/run/shot.pgm /mnt/us/pocketjs-dev/run/r2-chrome.pgm
# toggle direction (middle bottom)
echo tap-logical 154 390 > /mnt/us/pocketjs-dev/run/cmd
sleep 1
echo shot > /mnt/us/pocketjs-dev/run/cmd; sleep 2
cp /mnt/us/pocketjs-dev/run/shot.pgm /mnt/us/pocketjs-dev/run/r3-dir.pgm
# page turn right edge
echo tap-logical 280 200 > /mnt/us/pocketjs-dev/run/cmd
sleep 4
echo shot > /mnt/us/pocketjs-dev/run/cmd; sleep 2
cp /mnt/us/pocketjs-dev/run/shot.pgm /mnt/us/pocketjs-dev/run/r4-page.pgm
grep manga.page /mnt/us/pocketjs-dev/logs/runtime.log | tail -8
ps | grep pocketjs-kindle | grep -v grep || echo DEAD
ls -la /mnt/us/pocketjs-dev/run/r*.pgm
echo CHROME_E2E_OK
"'
