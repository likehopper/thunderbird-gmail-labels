#!/bin/sh
# Publishes the version of extension/manifest.json, depending on the branch:
# - main (1.2.0): GitHub release, then updates.json (only read by installs of 1.0.0).
#   The same .xpi must then be uploaded to addons.thunderbird.net, which manages updates.
# - beta (1.2.0b1): GitHub pre-release, with update_url in the .xpi.
# Both add the version to the beta feed: a stable version brings testers back to
# addons.thunderbird.net, since its .xpi has no update_url.
# The .xpi is published before the feeds, so a missing file is never announced.
set -e
cd "$(dirname "$0")"

FEED_TAG=beta-feed
FEED_FILE=updates-beta.json

version=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
tag="v$version"
branch=$(git branch --show-current)

case "$branch:$version" in
  main:*b*) echo "Set a stable version on main: $version is a beta" >&2; exit 1 ;;
  main:*) ;;
  beta:*b*) ;;
  beta:*) echo "Set a beta version on beta (1.2.0b1): $version is stable" >&2; exit 1 ;;
  *) echo "Run this from main or beta" >&2; exit 1 ;;
esac
[ -z "$(git status --porcelain)" ] || { echo "Uncommitted changes" >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "$tag already exists: raise the version" >&2; exit 1; }

if [ "$branch" = beta ]; then
  xpi=$(./build.sh --beta)
  git tag "$tag"
  git push -q origin beta "$tag"
  gh release create "$tag" "$xpi" --title "$version" --generate-notes --prerelease
else
  xpi=$(./build.sh)
  python3 scripts/update-manifest.py "$version" "$xpi"
  git add updates.json
  git commit -qm "Release $version"
  git tag "$tag"
  git push -q origin "$tag"
  gh release create "$tag" "$xpi" --title "$version" --generate-notes
  git push -q origin main
fi

# The feed is a release asset: it does not depend on a branch, and never conflicts
feed_dir=$(mktemp -d)
trap 'rm -rf "$feed_dir"' EXIT
if ! gh release view "$FEED_TAG" >/dev/null 2>&1; then
  gh release create "$FEED_TAG" --title "Beta update feed" --prerelease \
    --notes "Update feed of the beta versions. Do not delete."
fi
gh release download "$FEED_TAG" --pattern "$FEED_FILE" --dir "$feed_dir" 2>/dev/null || true
python3 scripts/update-manifest.py "$version" "$xpi" "$feed_dir/$FEED_FILE"
gh release upload "$FEED_TAG" "$feed_dir/$FEED_FILE" --clobber

if [ "$branch" = beta ]; then
  echo "$tag published as a pre-release"
else
  echo "$tag published: upload $xpi to addons.thunderbird.net"
fi
