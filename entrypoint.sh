#!/bin/sh
# Container entrypoint for microsoft-onenote-exporter.
#
# One image, five commands. The old images took a session GUID and a notebook
# name as positional arguments, which was tied to one pipeline's idea of what a
# session is; this dispatches on the subcommand instead, so the same image can
# also be used to log in or to list.

set -e

if [ $# -eq 0 ]; then
    echo "Usage: microsoft-onenote-exporter <command> [options]"
    echo ""
    echo "Commands:"
    echo "  login     Sign in to Microsoft and save the session"
    echo "  check     Report whether the saved session is still valid"
    echo "  logout    Delete the saved session"
    echo "  list      List the notebooks on the account"
    echo "  export    Export one notebook to Markdown"
    echo ""
    echo "Example:"
    echo "  docker run -v ./out:/data/output microsoft-onenote-exporter \\"
    echo "    export --auth-file /data/output/auth.json --notebook 'Work' --non-interactive"
    exit 0
fi

# A login cannot run headless: without an email and a password the browser has to
# be shown, and there is nobody at a terminal inside a container to type into it.
case "$1" in
    login)
        echo "ERROR: 'login' needs a visible browser, which a container has no way to show." >&2
        echo "       Log in on the host first, then mount the resulting auth file:" >&2
        echo "         microsoft-onenote-exporter login" >&2
        echo "         docker run -v \$HOME/.microsoft-webauth:/data/auth ..." >&2
        exit 2
        ;;
esac

# Allow a shell in the container for debugging, and node for poking at the CLI.
if [ "$1" = "/bin/sh" ] || [ "$1" = "sh" ]; then
    exec "$@"
fi
# `shift` first, then exec node with what is left. Without the shift this runs
# `node node <script>`, which node reads as a module path named "node" and fails
# with MODULE_NOT_FOUND - so the documented debugging route
#
#   docker run --rm -it microsoft-onenote-exporter node /app/src/index.js list
#
# never worked. Found by running the built image rather than by reading it.
if [ "$1" = "node" ]; then
    shift
    exec node "$@"
fi

# Where the notes go, unless the caller said otherwise.
#
# The container's working directory is /app, so the CLI's own default - ./output
# against the cwd - resolves to /app/output. That directory exists and is
# writable, so nothing fails: the export runs to completion and reports
# "Files saved in: /app/output/<notebook>". The notes are then destroyed with the
# container, because /app/output is inside the image rather than the mounted
# volume. A run that looked entirely successful and produced nothing on the host.
#
# /data/output is the volume mount, so that is the only default that survives.
# /app/output stays in the image as a fallback for anyone running the CLI with a
# working directory of their own choosing.
if [ ! -d /data/output ]; then
    # No volume mounted: warn rather than silently writing into the image, since
    # that is the failure this line exists to prevent.
    echo "WARNING: no volume is mounted at /data/output." >&2
    echo "         Exported notes will be written inside the container and lost" >&2
    echo "         when it exits. Mount one, for example:" >&2
    echo "           -v \"\$PWD/output:/data/output\"" >&2
else
    # Only `export` writes notes, so only `export` is offered --output-dir.
    #
    # Appending it for every subcommand broke the other three: `list`, `check` and
    # `logout` do not define that option, so commander answered
    #
    #   error: unknown option '--output-dir'
    #
    # and exited 1 - the container refused to list anything, while the flag it
    # complained about had been added here, not by the caller. `export` kept
    # working, which is why it went unnoticed: it was the only subcommand anyone
    # had run through a container.
    is_export=false
    for arg in "$@"; do
        if [ "$arg" = "export" ]; then
            is_export=true
            break
        fi
    done

    if [ "$is_export" = true ]; then
        # Appending --output-dir rather than exporting a variable, because the CLI
        # has no environment variable for it and its default resolves against a
        # cwd of /app. Only when the caller did not pass one, for the same reason
        # as --auth-file below: an explicit choice must never be overridden.
        has_output_dir=false
        for arg in "$@"; do
            if [ "$arg" = "--output-dir" ]; then
                has_output_dir=true
                break
            fi
        done
        if [ "$has_output_dir" = false ]; then
            set -- "$@" --output-dir /data/output
        fi
    fi
fi

# Only injected when the caller did not pass --auth-file themselves: appending it
# unconditionally would silently override an explicit choice, and the container
# would read a different session than the one asked for.
AUTH_FILE="${AUTH_FILE:-/data/output/auth.json}"
for arg in "$@"; do
    if [ "$arg" = "--auth-file" ]; then
        AUTH_FILE=""
        break
    fi
done

if [ -n "$AUTH_FILE" ]; then
    exec node /app/src/index.js "$@" --auth-file "$AUTH_FILE"
fi

exec node /app/src/index.js "$@"
