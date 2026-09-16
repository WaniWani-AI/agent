#!/bin/sh
set -eu

# Every secret accepts a `_FILE` variant so compose can mount it instead of
# putting it in the environment.
for name in WANIWANI_AGENT_SECRET WANIWANI_API_KEY WANIWANI_SERVICE_PRIVATE_KEY \
	WANIWANI_PUBLIC_KEY MODEL_API_KEY AI_GATEWAY_API_KEY; do
	eval "file=\${${name}_FILE:-}"
	if [ -n "$file" ]; then
		eval "$name=\$(cat \"\$file\")"
		export "$name"
	fi
done

node node_modules/@workflow/world-postgres/bin/setup.js

exec ./node_modules/.bin/eve start --host 0.0.0.0
