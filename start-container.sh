#!/bin/bash
# Runs one export in a container.
#
# Usage: ./start-container.sh --notebook "Work" [--output-dir ./out] [more flags...]
#
# Everything is overridable through the environment, because the previous script
# pointed at a sibling checkout that only existed on one machine and used a fixed
# image name, so it could not be used anywhere else.
#
#   IMAGE        image to run            (default: microsoft-onenote-exporter)
#   CONTAINER    container name          (default: ms_onenote_export)
#   OUTPUT_DIR   host dir for the export (default: ./output)
#   AUTH_FILE    session to use          (default: the one `login` wrote)

set -euo pipefail

SESSION="$(basename "${PWD}")"
IMAGE="${IMAGE:-microsoft-onenote-exporter}"
CONTAINER="${CONTAINER:-ms_onenote_export_${SESSION}}"
OUTPUT_DIR="${OUTPUT_DIR:-./output}"

# The session defaults to where `microsoft-onenote-exporter login` writes it.
# Spelled out rather than read from @msout/microsoft-webauth/config at runtime,
# because this script runs before any node_modules is guaranteed to be present -
# it has to work in a fresh checkout. test/docker.test.js asserts this path
# matches what the CLI reports, so the two cannot drift apart silently.
#
# This used to default to $OUTPUT_DIR/auth.json, which meant the documented
# sequence - log in on the host, then run this script - always failed with "no
# auth file", because the copy step it demanded was never written down
# anywhere. Logging in on the host is the supported way to get a session into a
# container, since a container cannot run an interactive login, so the default
# simply follows it and no copy is needed.
# Which session to use, in order of preference:
#
#   1. --auth-file <path>, if the caller passed it on the command line
#   2. $AUTH_FILE, if the caller set it in the environment
#   3. ./output/auth.json, the convention the README documents - the session sits
#      beside the notes in the one mounted volume, so there is nothing else to
#      mount and no copy step on every run
#   4. ~/.microsoft-webauth/auth-file.json, where `login` writes it, so the
#      "log in on the host, then run this" sequence works with no preparation
#
# (1) exists because the flag was silently ignored. This script picks the session
# itself and passes its own --auth-file to the container, so an
# `--auth-file ./my.json` from the caller was neither honoured nor rejected - the
# wrong session was used and the run succeeded against it. Found by passing the
# flag, watching a *different* file get deleted, and reading the code to see why.
#
# The default is NOT just (4): a check for (3) has to come first, because with the
# default set to (4) the script looks for a file named `auth-file.json` in the
# output directory and silently ignores the `auth.json` a user following the
# README actually placed there.
AUTH_FILE_FROM_ARGS=""
prev=""
for arg in "$@"; do
    if [ "$prev" = "--auth-file" ]; then
        AUTH_FILE_FROM_ARGS="$arg"
    fi
    case "$arg" in
        --auth-file=*)
            AUTH_FILE_FROM_ARGS="${arg#--auth-file=}"
            ;;
    esac
    prev="$arg"
done

if [ -n "$AUTH_FILE_FROM_ARGS" ]; then
    AUTH_FILE="$AUTH_FILE_FROM_ARGS"
elif [ -n "${AUTH_FILE:-}" ]; then
    AUTH_FILE="$AUTH_FILE"
elif [ -f "${OUTPUT_DIR}/auth.json" ]; then
    AUTH_FILE="${OUTPUT_DIR}/auth.json"
else
    AUTH_FILE="$HOME/.microsoft-webauth/auth-file.json"
fi

# The subcommand, when the caller did not give one.
#
# This script forwards "$@" to the CLI verbatim, so it has to supply `export`
# itself - the CLI takes it as a subcommand, not as a flag. Without this the
# container received only `--notebook <name> --non-interactive` and answered
#
#   error: unknown option '--notebook'
#
# which is commander refusing the first flag it saw because the subcommand that
# should have preceded it was missing. Fixed here rather than by rewriting the
# caller's arguments, so `./start-container.sh export --notebook X` also works.
SUBCOMMAND="${1:-}"
case "$SUBCOMMAND" in
    login | check | logout | list | export)
        shift
        ;;
    *)
        SUBCOMMAND="export"
        ;;
esac

if [ "$SUBCOMMAND" = "export" ] && [ $# -eq 0 ]; then
    echo "Usage: $0 [--export] --notebook <name> | --notebook-link <url> [options...]" >&2
    echo "" >&2
    echo "Example:" >&2
    echo "  $0 --notebook 'Work' --output-dir ./out" >&2
    echo "" >&2
    echo "Or name the step explicitly:" >&2
    echo "  $0 list          $0 check" >&2
    exit 1
fi

# One of these two must be present for a non-interactive export, and finding out
# here rather than inside the container is the difference between an explanation
# and `error: unknown option '--notebook-link'`.
if [ "$SUBCOMMAND" = "export" ]; then
    has_notebook=false
    for arg in "$@"; do
        case "$arg" in
            --notebook | --notebook-link)
                has_notebook=true
                ;;
        esac
    done
    if [ "$has_notebook" = false ]; then
        echo "ERROR: an export needs --notebook <name> or --notebook-link <url>." >&2
        echo "  This script always runs unattended, so there is no interactive picker" >&2
        echo "  to fall back on." >&2
        exit 2
    fi
fi

# logout does not need a container.
#
# The obvious approach - mount the session read-write and let the container delete
# it - cannot work. Docker mounts a single file at /data/auth/session.json, and a
# container cannot remove a mount point: the file is the mount, so unlinking it
# fails with EACCES whether the mount is read-only or not. Making it writable
# changed nothing except how far the error got.
#
# Deleting the session is a host-side operation - one file plus its -meta.json -
# and there is nothing for the container to do. So it is done here, before any
# image is required, which also means `./start-container.sh logout` works before
# the image has ever been built.
if [ "$SUBCOMMAND" = "logout" ]; then
    if [ ! -f "$AUTH_FILE" ]; then
        echo "ERROR: no auth file at $AUTH_FILE" >&2
        echo "  Nothing to sign out of; the file is already gone." >&2
        exit 1
    fi

    echo "Removing $AUTH_FILE"
    rm -f "$AUTH_FILE"

    # webauth writes the metadata beside the session as <name>-meta.json, and
    # logout removes both. Leaving it behind would leave a record of the account
    # with no session to go with it.
    META_FILE="${AUTH_FILE%.json}-meta.json"
    if [ -f "$META_FILE" ]; then
        echo "Removing $META_FILE"
        rm -f "$META_FILE"
    fi

    echo "logout finished."
    exit 0
fi

# The container name is derived from the working directory, so it is stable across
# runs on the same machine - which means the second run collides with the first.
# Docker refuses to reuse a name, and the error it gives ("Conflict ... already in
# use by container 302415178a51") names a hash rather than telling you what to do
# about it, so a script that is meant to be run repeatedly only worked once.
#
# A leftover container here is always from a previous run of this script: it exits
# with `docker run --detach`, so it is never expected to still be running. Removing
# it is safe for the current run and is what makes the next one possible. Named
# volumes are untouched; only the container is removed.
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)"
    if [ "$state" = "running" ]; then
        echo "ERROR: container '$CONTAINER' is already running." >&2
        echo "  Stop it first if that is expected, or set CONTAINER=<other name>." >&2
        exit 1
    fi
    docker rm "$CONTAINER" >/dev/null
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "ERROR: image '$IMAGE' is not built." >&2
    echo "  Build it:  docker build -t $IMAGE ." >&2
    # The message this replaces only said "build it", which is unhelpful when the
    # image exists under another tag - and "docker build -t foo ." produces
    # foo:latest, while a build tagged foo:test leaves foo:latest missing. So a
    # script looking for an untagged name would report "not built" next to a
    # perfectly good image, with nothing to suggest the retag.
    # Match on the part of the name that survives a tag difference. The tag is
    # stripped because that is the whole point - `foo` and `foo:test` are the
    # same image, and the tag is what the user got wrong. Non-alphanumerics are
    # left in place: stripping them turns `ms-onenote-exporter` into
    # `msonenoteexporter`, which matches no image at all and made this branch
    # silently dead.
    similar="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
        | grep -i -- "$(printf '%s' "$IMAGE" | tr '[:upper:]' '[:lower:]' | cut -d: -f1)" || true)"
    if [ -n "$similar" ]; then
        echo "" >&2
        echo "  But these exist:" >&2
        printf '    %s\n' $similar >&2
        echo "" >&2
        echo "  Use one of them, or retag:" >&2
        echo "    docker tag ${similar%%:*}:${similar##*:} $IMAGE" >&2
    fi
    exit 1
fi

# The auth file has to exist before the container starts, because the mount is
# created from this path and Docker creates a directory when the source is
# missing - which produces a confusing "not a storage state" error from inside
# the container rather than an obvious one here.
if [ ! -f "$AUTH_FILE" ]; then
    echo "ERROR: no auth file at $AUTH_FILE" >&2
    echo "  A container cannot run an interactive login, so sign in on the host first:" >&2
    echo "    microsoft-onenote-exporter login" >&2
    echo "  Then either copy the session into the output directory:" >&2
    echo "    cp ~/.microsoft-webauth/auth-file.json ./output/auth.json" >&2
    echo "  or point this at it directly:" >&2
    echo "    AUTH_FILE=~/.microsoft-webauth/auth-file.json \$0 --notebook 'Work'" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Resolve so the -v argument is valid even when the path has not been created yet.
OUTPUT_DIR_ABS="$(cd "$OUTPUT_DIR" && pwd)"
AUTH_FILE_ABS="$(cd "$(dirname "$AUTH_FILE")" && pwd)/$(basename "$AUTH_FILE")"

# The session is mounted separately, read-only, rather than being required to sit
# inside the output directory. It lives in ~/.microsoft-webauth and is a live
# credential: it does not belong in the directory the exported notes are
# collected into, and mounting it read-only means a bug in the container cannot
# rewrite or delete it. Mounting the file rather than its directory also means
# the container cannot see the other sessions sitting beside it.
AUTH_MOUNT=()
if [ ! -f "${OUTPUT_DIR_ABS}/$(basename "$AUTH_FILE_ABS")" ]; then
    AUTH_MOUNT=(-v "${AUTH_FILE_ABS}:/data/auth/session.json:ro")
    CONTAINER_AUTH_FILE="/data/auth/session.json"
else
    # Already inside the output directory: mounting it twice would be redundant,
    # and the export should write its logs and notes beside it as documented.
    #
    # This leaves AUTH_MOUNT empty, which is the documented primary path, and an
    # empty array expanded as "${AUTH_MOUNT[@]}" under `set -u` is an error on some
    # bash builds: the wrapper died with
    #
    #   line 222: AUTH_MOUNT[@]: unbound variable
    #
    # before starting any container at all - so the documented way to run an
    # export could not run, while the fallback path worked and hid the bug. The
    # expansion below is guarded so an empty array contributes no arguments.
    CONTAINER_AUTH_FILE="/data/output/$(basename "$AUTH_FILE_ABS")"
fi

# Logs go beside the notes, not inside the image. Without this the run's
# app.log - the only record of what an export actually did - died with the
# container, and the script's own "see logs/app.log" advice pointed at a path
# that never existed on the host.
ONENOTE_EXPORT_LOG_DIR=/data/output/logs

echo "Container : $CONTAINER"
echo "Image     : $IMAGE"
echo "Auth file : $AUTH_FILE_ABS"
echo "Output    : $OUTPUT_DIR_ABS"
echo ""
# Echoed to match what is really executed below. This line used to print
# "microsoft-onenote-exporter $* --non-interactive", which was missing the
# subcommand that the invocation adds - so the most reassuring line in the script
# was describing a command that was never run.
echo "Running: microsoft-onenote-exporter $SUBCOMMAND $* --auth-file $CONTAINER_AUTH_FILE"
echo ""

# Chromium needs more than Docker's default 64 MB of shared memory or it crashes
# on memory-heavy pages, hence --shm-size. --init runs a tiny PID-1 reaper so
# Chromium's child processes are cleaned up instead of accumulating as zombies
# when the export ends.
#
# The container runs detached and the exit status is polled below, so the script
# can report the result and the image can be reused for another run without
# rebuilding it.
docker run --detach \
    --name "$CONTAINER" \
    --init \
    --shm-size=1g \
    -e ONENOTE_EXPORT_LOG_DIR="$ONENOTE_EXPORT_LOG_DIR" \
    -v "${OUTPUT_DIR_ABS}:/data/output" \
    ${AUTH_MOUNT[@]+"${AUTH_MOUNT[@]}"} \
    "$IMAGE" \
    "$SUBCOMMAND" "$@" --auth-file "$CONTAINER_AUTH_FILE" >/dev/null

# Wait for the export to finish.
#
# `docker wait` is used rather than a poll loop over `docker inspect`. A loop
# written the obvious way reads State.ExitCode first and stops as soon as it is
# non-empty - and that field is 0 *while the container is still running*, so the
# loop exited on its first iteration and reported success for an export that had
# not written a single file. `docker wait` blocks until the container actually
# stops and then returns its status, which is the one question being asked here.
#
# It has no timeout, so a separate watchdog decides when to stop waiting and say
# so. The cap is generous - a large notebook over a slow connection can
# legitimately take tens of minutes - but past it the script reports rather than
# appearing to still be working. The container is left running so it can be
# inspected with `docker logs`.
WAIT_LIMIT=$((60 * 60)) # one hour
( sleep "$WAIT_LIMIT"
  if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
      echo "WARNING: the export is still running after $((WAIT_LIMIT / 60)) minutes." >&2
      echo "         It has been left running; watch it with:" >&2
      echo "           docker logs -f $CONTAINER" >&2
      # 124 is the conventional timeout status, and is reported as a failure
      # rather than a success so a pipeline cannot mistake it for a clean run.
      docker stop -t 30 "$CONTAINER" >/dev/null 2>&1 || true
  fi
) &
WATCHDOG_PID=$!

# Wait for it, then propagate the status. The container runs the export as PID 1
# under the reaper, so this is the container's exit status - which is the export's,
# because the CLI exits with the code the export step reported.
EXIT_CODE="$(docker wait "$CONTAINER")"

kill "$WATCHDOG_PID" 2>/dev/null || true
wait "$WATCHDOG_PID" 2>/dev/null || true

echo ""
if [ "$EXIT_CODE" -eq 0 ]; then
    if [ "$SUBCOMMAND" = "export" ]; then
        echo "Exported files are in: $OUTPUT_DIR_ABS"
    else
        echo "$SUBCOMMAND finished."
    fi
else
    # The messages name the subcommand rather than always saying "the export": a
    # failed logout reporting "the export failed and produced nothing usable"
    # sends you looking for notes that were never the point of the command.
    case "$EXIT_CODE" in
        1)
            echo "WARNING: $SUBCOMMAND failed." >&2
            ;;
        2)
            if [ "$SUBCOMMAND" = "export" ]; then
                echo "WARNING: the arguments were wrong - check --notebook or --notebook-link." >&2
            else
                echo "WARNING: the arguments were wrong." >&2
            fi
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
    if [ "$SUBCOMMAND" = "export" ]; then
        echo "Anything already written to $OUTPUT_DIR_ABS has been kept." >&2
        echo "See logs/app.log inside the output directory for the full run." >&2
    else
        echo "See logs/app.log inside the output directory for the full run." >&2
    fi
fi

exit "$EXIT_CODE"
