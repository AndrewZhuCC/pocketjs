#!/bin/sh
# Managed by PocketJS Kindle bootstrap. Local edits will be replaced.
#
# Run Runtime always passes absolute guest paths so bare launches (KUAL menu)
# work without relying on process cwd. Defaults match hosts/kindle README.

set -u

POCKETJS_DEV_ROOT="${POCKETJS_DEV_ROOT:-/mnt/us/pocketjs-dev}"
POCKETJS_JS="${POCKET_JS:-$POCKETJS_DEV_ROOT/current/app.js}"
POCKETJS_PAK="${POCKET_PAK:-$POCKETJS_DEV_ROOT/current/app.pak}"
POCKETJS_FBINK="${POCKETJS_FBINK:-$POCKETJS_DEV_ROOT/bin/fbink}"

case "${1:-}" in
    start-ssh)
        exec sh "$POCKETJS_DEV_ROOT/start-ssh.sh"
        ;;
    stop-ssh)
        exec sh "$POCKETJS_DEV_ROOT/stop-ssh.sh"
        ;;
    run-runtime)
        exec sh "$POCKETJS_DEV_ROOT/run-runtime.sh" \
            --js "$POCKETJS_JS" \
            --pak "$POCKETJS_PAK" \
            --fbink "$POCKETJS_FBINK"
        ;;
    stop-runtime)
        exec sh "$POCKETJS_DEV_ROOT/stop-runtime.sh"
        ;;
    diagnose)
        exec sh "$POCKETJS_DEV_ROOT/diagnose.sh"
        ;;
    *)
        echo "PocketJS KUAL: unknown command ${1:-<missing>}" >&2
        exit 2
        ;;
esac
