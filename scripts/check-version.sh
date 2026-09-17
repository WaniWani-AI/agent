#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
tag="${1:-${GITHUB_REF_NAME:-}}"
version="$(node -p "require('./packages/adapter/package.json').version")"
if [[ ! "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$ || "$tag" != "v$version" ]]; then
  echo "::error::Tag '$tag' must match adapter version 'v$version' (vX.Y.Z or vX.Y.Z-prerelease)." >&2
  exit 1
fi
npm_tag=latest
if [[ "$version" == *-* ]]; then
  prerelease="${version#*-}"
  npm_tag="${prerelease%%.*}"
fi
if [[ ! "$npm_tag" =~ ^[A-Za-z][0-9A-Za-z-]*$ ]]; then
  echo "::error::Version '$version' yields dist-tag '$npm_tag', which npm rejects. Start the prerelease with a name, e.g. -beta.0 or -rc.1." >&2
  exit 1
fi
printf 'VERSION=%s\nNPM_TAG=%s\n' "$version" "$npm_tag"
