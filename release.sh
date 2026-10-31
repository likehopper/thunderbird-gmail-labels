#!/bin/sh
# Publishes the version of extension/manifest.json: a GitHub release with the .xpi,
# then updates.json on main (read by Thunderbird for automatic updates).
# The .xpi is published before updates.json, so a missing file is never announced.
set -e
cd "$(dirname "$0")"

version=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
tag="v$version"

[ "$(git branch --show-current)" = main ] || { echo "Run this from main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Uncommitted changes" >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "$tag already exists: raise the version" >&2; exit 1; }

xpi=$(./build.sh)
python3 scripts/update-manifest.py "$version" "$xpi"
git add updates.json
git commit -qm "Release $version"
git tag "$tag"

git push -q origin "$tag"
gh release create "$tag" "$xpi" --title "$version" --generate-notes
git push -q origin main
echo "$tag published"
