#!/usr/bin/env python3
"""Adds a version to updates.json: update-manifest.py <version> <file.xpi>."""
import hashlib
import json
import os
import sys

REPOSITORY_URL = "https://github.com/likehopper/thunderbird-gmail-labels"
UPDATES_PATH = "updates.json"

version, xpi_path = sys.argv[1:3]
manifest = json.load(open("extension/manifest.json"))
gecko_settings = manifest["browser_specific_settings"]["gecko"]
extension_id = gecko_settings["id"]

if os.path.exists(UPDATES_PATH):
    update_manifest = json.load(open(UPDATES_PATH))
else:
    update_manifest = {"addons": {extension_id: {"updates": []}}}

xpi_hash = hashlib.sha256(open(xpi_path, "rb").read()).hexdigest()
update_manifest["addons"][extension_id]["updates"].append({
    "version": version,
    "update_link": f"{REPOSITORY_URL}/releases/download/v{version}/{os.path.basename(xpi_path)}",
    "update_hash": f"sha256:{xpi_hash}",
    "applications": {"gecko": {"strict_min_version": gecko_settings["strict_min_version"]}},
})

with open(UPDATES_PATH, "w") as updates_file:
    json.dump(update_manifest, updates_file, indent=2)
    updates_file.write("\n")
