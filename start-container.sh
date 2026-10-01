#!/bin/bash
# Runs one export in a container.
#
# Usage: ./start-container.sh --notebook "Work" [--output-dir ./out] [more flags...]
#
# Everything is overridable through the environment, because the previous script
# pointed at a sibling checkout that only existed on one machine and used a fixed
# image name, so it could not be used anywhere else.
#
#   IMAGE        image to run            (default: ms-onenote-exporter)
#   CONTAINER    container name          (default: ms_onenote_export)
#   OUTPUT_DIR   host dir for the export (default: ./output)
#   AUTH_FILE    session to use          (default: $OUTPUT_DIR/auth.json)

set -euo pipefail

SESSION="$(basename "${PWD}")"
IMAGE="${IMAGE:-ms-onenote-exporter}"
CONTAINER="${CONTAINER:-ms_onenote_export_${SESSION}}"
OUTPUT_DIR="${OUTPUT_DIR:-./output}"
AUTH_FILE="${AUTH_FILE:-${OUTPUT_DIR}/auth.json}"

if [ $# -eq 0 ]; then
    echo "Usage: $0 --notebook <name> | --notebook-link <url> [options...]" >&2
    echo "" >&2
    echo "Example:" >&2
    echo "  $0 --notebook 'Work' --output-dir ./out" >&2
    exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "ERROR: image '$IMAGE' is not built." >&2
    echo "  Build it first:  docker build -t $IMAGE ." >&2
    exit 1
fi

# The auth file has to exist before the container starts, because the mount is
# created from this path and Docker creates a directory when the source is
# missing - which produces a confusing "not a storage state" error from inside
# the container rather than an obvious one here.
if [ ! -f "$AUTH_FILE" ]; then
    echo "ERROR: no auth file at $AUTH_FILE" >&2
    echo "  Log in on the host first, then point this at the result:" >&2
    echo "    ms-onenote-exporter login" >&2
    echo "    cp ~/.microsoft-webauth/auth-file.json \"$AUTH_FILE\"" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Resolve so the -v argument is valid even when the path has not been created yet.
OUTPUT_DIR_ABS="$(cd "$OUTPUT_DIR" && pwd)"
AUTH_FILE_ABS="$(cd "$(dirname "$AUTH_FILE")" && pwd)/$(basename "$AUTH_FILE")"

echo "Container : $CONTAINER"
echo "Image     : $IMAGE"
echo "Auth file : $AUTH_FILE_ABS"
echo "Output    : $OUTPUT_DIR_ABS"
echo ""
echo "Running: ms-onenote-exporter $* --non-interactive"
echo ""

# Chromium needs more than Docker's default 64 MB of shared memory or it crashes
# on memory-heavy pages, hence --shm-size. --init runs a tiny PID-1 reaper so
# Chromium's child processes are cleaned up instead of accumulating as zombies
# when the export ends.
#
# The container runs detached and the export is awaited with `docker wait`, so the
# script can report the result and the image can be reused for another run
# without rebuilding it.
docker run --detach \
    --name "$CONTAINER" \
    --init \
    --shm-size=1g \
    -v "${OUTPUT_DIR_ABS}:/data/output" \
    "$IMAGE" \
    "$@" --auth-file "/data/output/$(basename "$AUTH_FILE_ABS")" >/dev/null

# Wait for it, then propagate the status. The container runs the export as PID 1
# under the reaper, so this is the container's exit status - which is the export's,
# because the CLI exits with the code the export step reported.
EXIT_CODE="$(docker wait "$CONTAINER")"

echo ""
if [ "$EXIT_CODE" -eq 0 ]; then
    echo "Exported files are in: $OUTPUT_DIR_ABS"
else
    case "$EXIT_CODE" in
        1)
            echo "WARNING: the export failed and produced nothing usable." >&2
            ;;
        2)
            echo "WARNING: the arguments were wrong - check --notebook or --notebook-link." >&2
            ;;
        3)
            echo "NOTE: the export finished but some pages, sections or groups are missing." >&2
            echo "      The notes that were written are complete and name any asset they" >&2
            echo "      could not download. Re-run to try again." >&2
            ;;
        *)
            echo "WARNING: the container exited with status $EXIT_CODE." >&2
            ;;
    esac
    echo "Anything already written to $OUTPUT_DIR_ABS has been kept." >&2
    echo "See logs/app.log inside the output directory for the full run." >&2
fi

exit "$EXIT_CODE"
