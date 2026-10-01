#!/bin/sh
# Container entrypoint for ms-onenote-exporter.
#
# One image, five commands. The old images took a session GUID and a notebook
# name as positional arguments, which was tied to one pipeline's idea of what a
# session is; this dispatches on the subcommand instead, so the same image can
# also be used to log in or to list.

set -e

if [ $# -eq 0 ]; then
    echo "Usage: ms-onenote-exporter <command> [options]"
    echo ""
    echo "Commands:"
    echo "  login     Sign in to Microsoft and save the session"
    echo "  check     Report whether the saved session is still valid"
    echo "  logout    Delete the saved session"
    echo "  list      List the notebooks on the account"
    echo "  export    Export one notebook to Markdown"
    echo ""
    echo "Example:"
    echo "  docker run -v ./out:/data/output ms-onenote-exporter \\"
    echo "    export --auth-file /data/output/auth.json --notebook 'Work' --non-interactive"
    exit 0
fi

# A login cannot run headless: without an email and a password the browser has to
# be shown, and there is nobody at a terminal inside a container to type into it.
case "$1" in
    login)
        echo "ERROR: 'login' needs a visible browser, which a container has no way to show." >&2
        echo "       Log in on the host first, then mount the resulting auth file:" >&2
        echo "         ms-onenote-exporter login" >&2
        echo "         docker run -v \$HOME/.microsoft-webauth:/data/auth ..." >&2
        exit 2
        ;;
esac

# Allow a shell in the container for debugging, and node for poking at the CLI.
if [ "$1" = "/bin/sh" ] || [ "$1" = "sh" ]; then
    exec "$@"
fi
if [ "$1" = "node" ]; then
    exec node "$@"
fi

# /data/output is the mount point the docs and start-container.sh use for both the
# auth file and the exported notes, so a run needs one volume, not two.
#
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
