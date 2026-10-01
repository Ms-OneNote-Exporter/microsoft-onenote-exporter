#!/bin/sh
# Installs the three step packages from sibling checkouts instead of the registry.
#
# Why this exists: this package depends on three sibling repositories, and the
# versions it pins (0.1.8 / 0.0.6 / 0.3.7) do not exist on npm until they are
# published. So the first thing anyone building this needs - a working `npm test`
# before a publish - is impossible with a plain `npm install`.
#
# What it does, and does not, change:
#
#   - packs each sibling checkout into .local-tarballs/
#   - points this package's three dependencies at those tarballs
#   - runs npm install
#   - puts package.json and package-lock.json back exactly as they were
#
# So the tracked manifest keeps pinning published versions and can never be
# committed with a `file:` spec in it, while node_modules holds local builds.
# `npm run use:published` undoes the install.
#
# The siblings are expected one directory up, which is how the four repositories
# sit side by side in a workspace. Override with SIBLING_DIRS=a:b:c if not.

set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

OUT="$ROOT/.local-tarballs"
DEFAULT_SIBLINGS="../microsoft-webauth ../microsoft-onenote-list-notebooks ../microsoft-onenote-export-notebook"
SIBLING_DIRS=${SIBLING_DIRS:-$DEFAULT_SIBLINGS}

if ! command -v npm >/dev/null 2>&1; then
    echo "error: npm is not on PATH" >&2
    exit 1
fi

for dir in $SIBLING_DIRS; do
    if [ ! -f "$dir/package.json" ]; then
        echo "error: no package.json in $dir" >&2
        echo "       Set SIBLING_DIRS to the directories holding the three packages." >&2
        exit 1
    fi
done

cp package.json .local-package.json.bak
cp package-lock.json .local-package-lock.json.bak 2>/dev/null || true

restore() {
    mv .local-package.json.bak package.json
    if [ -f .local-package-lock.json.bak ]; then
        mv .local-package-lock.json.bak package-lock.json
    else
        rm -f package-lock.json
    fi
}
# Any exit from here on must leave the tracked manifest as it was found.
trap restore EXIT INT TERM

rm -rf "$OUT"
mkdir -p "$OUT"

for dir in $SIBLING_DIRS; do
    name=$(node -p "require('$dir/package.json').name")
    version=$(node -p "require('$dir/package.json').version")
    echo "packing $name@$version from $dir"

    # --json so the filename is read back from npm rather than guessed: the name
    # is scope-flattened and the version stamped, and guessing it wrong would
    # produce a tarball npm cannot find.
    tarball=$(cd "$dir" && npm pack --silent --pack-destination "$OUT" 2>/dev/null | tail -1)
    if [ -z "$tarball" ] || [ ! -f "$OUT/$tarball" ]; then
        echo "error: npm pack produced no tarball for $name in $dir" >&2
        exit 1
    fi

    npm pkg set "dependencies.$name=file:$OUT/$tarball" >/dev/null
done

echo "installing with local step packages..."
npm install --no-audit --no-fund

restore
trap - EXIT INT TERM

echo
echo "Done. node_modules now holds the local builds:"
for dir in $SIBLING_DIRS; do
    name=$(node -p "require('$dir/package.json').name")
    printf '  %-45s %s\n' "$name" "$(node -p "require('./node_modules/$name/package.json').version")"
done
echo
echo "package.json still pins the published versions; only node_modules differs."
echo "Run 'npm run use:published' to go back to the registry copies."
