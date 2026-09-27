#!/bin/sh
# fetch-artifact <file-name> <url> <dest>
# Takes /opt/vendor/<file-name> when it was vendored by hand, otherwise downloads <url> (point the
# base URL at an Artifactory remote). Either way the bytes must match the file's line in
# /opt/vendor/SHA256SUMS: a missing line or a mismatch fails the build.
set -eu
name="$1"; url="$2"; dest="$3"
expected=$(awk -v n="$name" '$2 == n { print $1 }' /opt/vendor/SHA256SUMS)
[ -n "$expected" ] || { echo "fetch-artifact: no checksum for $name in slim/vendor/SHA256SUMS" >&2; exit 1; }
if [ -f "/opt/vendor/$name" ]; then
  cp "/opt/vendor/$name" "$dest"; src="slim/vendor"
else
  curl -fsSL --retry 3 -o "$dest" "$url" || { echo "fetch-artifact: cannot download $url — vendor $name into slim/vendor/ or point the base URL at a mirror" >&2; exit 1; }
  src="$url"
fi
actual=$(sha256sum "$dest" | awk '{ print $1 }')
[ "$actual" = "$expected" ] || { echo "fetch-artifact: checksum mismatch for $name (from $src)" >&2; exit 1; }
echo "fetch-artifact: $name verified (from $src)"
