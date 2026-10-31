#!/bin/sh
# Builds dist/thunderbird-gmail-labels-<version>.xpi from extension/
set -e
cd "$(dirname "$0")"
version=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
xpi="dist/thunderbird-gmail-labels-$version.xpi"
mkdir -p dist
rm -f "$xpi"
(cd extension && zip -qr -X "../$xpi" . -x '.*')
echo "$xpi"
