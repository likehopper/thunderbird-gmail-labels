#!/bin/sh
# Builds dist/thunderbird-gmail-labels-<version>.xpi from extension/
# --beta adds update_url to the built manifest, never to extension/manifest.json:
# addons.thunderbird.net rejects it, and a merge of beta into main must stay safe.
set -e
cd "$(dirname "$0")"
BETA_UPDATE_URL="https://github.com/likehopper/thunderbird-gmail-labels/releases/download/beta-feed/updates-beta.json"
version=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
xpi="dist/thunderbird-gmail-labels-$version.xpi"
mkdir -p dist
rm -f "$xpi"
if [ "$1" = --beta ]; then
  build_dir=$(mktemp -d)
  trap 'rm -rf "$build_dir"' EXIT
  cp -R extension/. "$build_dir"
  python3 scripts/set-update-url.py "$build_dir/manifest.json" "$BETA_UPDATE_URL"
  root=$PWD
  (cd "$build_dir" && zip -qr -X "$root/$xpi" . -x '.*')
else
  (cd extension && zip -qr -X "../$xpi" . -x '.*')
fi
echo "$xpi"
