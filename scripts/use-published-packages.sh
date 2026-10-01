#!/bin/sh
# Replaces the local builds with the published packages from the registry.
#
# The inverse of use-local-packages.sh, for the moment you want to check that the
# published tarballs really do work - which is a different question from whether
# the working trees do, and the only way to answer it before trusting a release.
#
# If the pinned versions have not been published yet, this fails. That is correct
# behaviour: it means the pin and the registry disagree, which is worth knowing
# before a release rather than after.

set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

rm -rf "$ROOT/.local-tarballs"

echo "removing the local step packages..."
npm uninstall @msout/microsoft-webauth @msout/microsoft-onenote-list-notebooks @msout/microsoft-onenote-export-notebook --no-audit --no-fund >/dev/null 2>&1 || true

echo "installing the published versions from package.json..."
npm install --no-audit --no-fund

echo
echo "Installed:"
for name in @msout/microsoft-webauth @msout/microsoft-onenote-list-notebooks @msout/microsoft-onenote-export-notebook; do
    installed=$(node -p "require('./node_modules/$name/package.json').version" 2>/dev/null || echo "NOT INSTALLED")
    pinned=$(node -p "require('./package.json').dependencies['$name']")
    printf '  %-45s pinned %-8s installed %s\n' "$name" "$pinned" "$installed"
done
