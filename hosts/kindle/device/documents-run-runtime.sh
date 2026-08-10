#!/bin/sh
# Name: PocketJS Dev - Run Runtime
# Author: PocketJS
# Managed by PocketJS Kindle bootstrap. Local edits will be replaced.
#
# Absolute paths so Library scriptlets work without a deploy-time cwd.

POCKETJS_DEV_ROOT="${POCKETJS_DEV_ROOT:-/mnt/us/pocketjs-dev}"
POCKETJS_JS="${POCKET_JS:-$POCKETJS_DEV_ROOT/current/app.js}"
POCKETJS_PAK="${POCKET_PAK:-$POCKETJS_DEV_ROOT/current/app.pak}"
POCKETJS_FBINK="${POCKETJS_FBINK:-$POCKETJS_DEV_ROOT/bin/fbink}"

exec sh "$POCKETJS_DEV_ROOT/run-runtime.sh" \
    --js "$POCKETJS_JS" \
    --pak "$POCKETJS_PAK" \
    --fbink "$POCKETJS_FBINK"
