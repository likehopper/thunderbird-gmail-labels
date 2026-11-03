#!/usr/bin/env python3
"""Adds update_url to a built manifest: set-update-url.py <manifest.json> <url>."""
import json
import sys

manifest_path, update_url = sys.argv[1:3]
manifest = json.load(open(manifest_path))
manifest["browser_specific_settings"]["gecko"]["update_url"] = update_url

with open(manifest_path, "w") as manifest_file:
    json.dump(manifest, manifest_file, indent=2)
    manifest_file.write("\n")
