#!/usr/bin/env bash
# Builds the Chrome Web Store upload ZIP from extension/.
# manifest.json sits at the root of the archive; the source icon.svg and dotfiles are left out.
# Usage: scripts/package.sh [expected-version]
# When expected-version is given (a release tag such as v1.2.3 or 1.2.3), the build fails
# unless it matches the version in extension/manifest.json.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

version="$(node -p "require('./extension/manifest.json').version")"

if [[ $# -gt 0 ]]; then
	expected="${1#v}"
	if [[ "$expected" != "$version" ]]; then
		echo "Version mismatch: tag says $expected but extension/manifest.json says $version." >&2
		exit 1
	fi
fi

mkdir -p dist
out="$root/dist/github-co-authors-generator-$version.zip"
rm -f "$out"

(cd extension && zip -r -X -q "$out" . -x 'icons/icon.svg' -x '.*' -x '*/.*')

echo "$out"
