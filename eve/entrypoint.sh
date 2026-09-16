#!/bin/sh
set -eu

# Every secret accepts a `_FILE` variant so compose can mount it instead of
# putting it in the environment. `export name=value` rather than an eval, so a
# multi-line PEM survives.
for name in WANIWANI_AGENT_SECRET WANIWANI_API_KEY WANIWANI_SERVICE_PRIVATE_KEY \
	WANIWANI_PUBLIC_KEY MODEL_API_KEY AI_GATEWAY_API_KEY; do
	eval "file=\${${name}_FILE:-}"
	if [ -n "$file" ]; then
		value=$(cat "$file")
		export "$name=$value"
	fi
done

# One credential form, chosen by the environment. Checked here rather than in the
# channel so `eve build` stays independent of a deployment's configuration.
forms=0
if [ -n "${WANIWANI_API_KEY:-}" ]; then forms=$((forms + 1)); fi
if [ -n "${WANIWANI_AGENT_SECRET:-}" ]; then forms=$((forms + 1)); fi
if [ "$forms" -ne 1 ]; then
	echo "Set exactly one of WANIWANI_API_KEY (self-hosted) and WANIWANI_AGENT_SECRET (hosted)" >&2
	exit 1
fi

node node_modules/@workflow/world-postgres/bin/setup.js

exec ./node_modules/.bin/eve start --host 0.0.0.0
