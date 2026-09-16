# Self-hosted agent

This repository runs the WaniWani website-chat agent inside your own infrastructure, against a
configuration you publish in WaniWani.

## What runs

`compose.yaml` starts two services.

**eve**, built from `eve/`, owns the conversation, talks to the model and calls your MCP server's
tools over MCP. It listens on port 3001 and is the only service you publish.

**postgres** holds eve's durable session state, so a conversation survives a container restart.

Your MCP server runs wherever you already run it. The runtime reads its URL from the published
configuration, and `WANIWANI_MCP_URL` overrides that when the address WaniWani knows is not the
address reachable from inside your network.

## Enrolling

1. Create an environment key (`wwk_…`) for the environment this deployment serves.

2. Write the secret file that `compose.yaml` mounts:

   ```sh
   mkdir -p .secrets
   printf %s 'wwk_...' > .secrets/api_key
   chmod 600 .secrets/*
   sudo chown 1000:1000 .secrets/*   # linux only
   ```

   Compose bind-mounts file-backed secrets with the source file's owner and mode,
   and the image runs as UID 1000. A `0600` file owned by anyone else is
   unreadable inside the container and the runtime exits at startup.

   `api_key` is your identity to WaniWani and the credential your backend presents to the
   runtime. A self-hosted deployment needs nothing else.

3. Copy `.env.example` to `.env` and fill in `POSTGRES_PASSWORD`. Generate it with
   `openssl rand -hex 32`: compose interpolates it straight into a `postgres://` URL, so a
   password carrying `#`, `/`, `@` or `:` produces a URL the runtime cannot parse.

4. Start it:

   ```sh
   docker compose up --build -d --wait
   curl http://127.0.0.1:3001/eve/v1/health
   ```

## The session credential

The runtime accepts exactly one credential form, chosen by which variable is set. Setting both, or
neither, refuses to start.

**Self-hosted, when `WANIWANI_API_KEY` is set.** Your backend sends that environment key:
`Authorization: Bearer wwk_…`, compared in constant time. Holding the key Eve holds is the proof,
and the runtime never calls WaniWani to check it. Two optional headers travel with it:

| Header | Meaning |
| --- | --- |
| `x-waniwani-visitor` | The visitor this request belongs to. Defaults to `anonymous`. |
| `x-waniwani-extra` | JSON context, passed through to your MCP server as `_meta["waniwani/extra"]`. |

Never let the key reach a browser. The visitor header is an assertion by your backend, so the
runtime trusts it exactly as far as it trusts the key holder.

**WaniWani-hosted, when `WANIWANI_AGENT_SECRET` is set.** One short-lived HS256 JWT per visitor,
minted server-side.

| Claim | Value |
| --- | --- |
| `iss` | `waniwani:agent` |
| `aud` | `waniwani-agent-runtime` |
| `sub` | The visitor's id, or the literal `anonymous`. Never empty. |
| `environmentId` | Required. Which environment this conversation belongs to. |
| `channelId` | Optional. The channel the conversation is attributed to. |
| `sid` | The session this token may address. Omit it on the request that creates a session; required on every request that names one. |
| `exp` | At most five minutes out. |
| `jti` | Unique per token. |

`x-waniwani-extra` works on this form too. Every custom claim is a string.

## Who may address a session

eve authenticates every session-addressed route and authorizes none of them. `routeAuth` runs the
channel's auth function and then hands the request straight to `attachSession(sessionId)`, so a
credential that verifies would otherwise be accepted against any session id it names.

On the hosted form the token closes that itself. Mint it without `sid` for the request that
creates a session, then with `sid` set to the id that comes back for every request that names one.
The channel compares the claim against the session in the URL and rejects a mismatch, which covers
the stream, cancel, clear, compact and reset routes as well as follow-up turns.

On the self-hosted form the credential is the environment key, which lives in your backend and
never reaches a browser. Whoever holds it already speaks for the whole environment, so there is
nothing to separate; the `x-waniwani-visitor` header is an assertion that backend makes, not a
credential the visitor presents.

Either way a turn is also checked at `turn.started`: a continuation whose environment or visitor
differs from the session's creator fails.

## How configuration reaches a turn

At `turn.started` the runtime resolves the tenant from the session token, then reads one copy of
the published configuration and one copy of your MCP server's tool list out of memory. A turn
never waits for WaniWani, so a deployment on the other side of a slow link answers as fast as one
next door.

Freshness rides alongside. After a turn starts, the runtime asks the app whether anything moved,
using `If-None-Match`, which is a 304 whenever nothing has. That check runs at most once a minute
per tenant, never on the turn path, and an idle deployment makes no requests at all. When
something has moved, the new copy lands on the turn after the check.

The configuration and the tool list move together on purpose. A published prompt describes the
tools your app deploys, so refreshing one without the other leaves the agent describing tools it
does not have.

A failed check keeps the copy already in memory and logs. Conversations carry on. A deployment
that has never loaded a configuration fails the turn with that error rather than answering on a
prompt nobody published, and retries at the same one-minute cadence rather than on every message.

## Reaching your MCP server

A self-hosted runtime forwards its environment key to your MCP server as
`Authorization: Bearer wwk_…`, which is what the hosted chat route already does, so a server that
authenticates the key accepts the agent too.

A WaniWani-hosted runtime sends no such header. The app stores only a hash of that key, so nothing
can hand the runtime the plaintext. Until a credential broker lands, a hosted runtime works
against an MCP server that does not require the key.

## The model

WaniWani resolves the model when it serves the configuration. The runtime never substitutes a
different one.

| Mode | Endpoint | Key |
| --- | --- | --- |
| `managed` | `AI_GATEWAY_BASE_URL`, or the Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| `byo` | The base URL on the payload | The key on the payload, else `MODEL_API_KEY` |

A missing key fails the turn with a message naming the variable. There is no fallback.

A self-hosted deployment on its own model sets `MODEL_API_KEY` to that provider's key. A hosted
runtime has no equivalent, because the org's credential is sealed in the app and the published
config carries no key, so hosted deployments are on managed inference until a broker lands.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `WORKFLOW_POSTGRES_URL` | yes | Postgres holding durable session state. |
| `WORKFLOW_LOCAL_BASE_URL` | yes | How the runtime reaches itself, e.g. `http://eve:3001`. |
| `POSTGRES_PASSWORD` | yes | Read by `compose.yaml`, which refuses to start without it. |
| `WANIWANI_API_KEY` | one of | The environment key (`wwk_…`). Selects the self-hosted form. |
| `WANIWANI_AGENT_SECRET` | one of | HMAC secret for the visitor JWT. Selects the WaniWani-hosted form. |
| `WANIWANI_SERVICE_PRIVATE_KEY` | with the secret | Ed25519 PKCS8 PEM the config fetch signs its service token with. |
| `WANIWANI_REGION` | with the PEM | `us` or `eu`. The audience the service token is minted for. |
| `WANIWANI_CHANNEL_ID` | no | Self-hosted only. The channel turns are attributed to. Must be one the environment published, or the turn fails naming it. Defaults to the environment's first channel. |
| `MODEL_API_KEY` | for `byo` | Key for your own model, when the payload carries none. |
| `AI_GATEWAY_API_KEY` | for `managed` | Key for managed inference. |
| `WANIWANI_PUBLIC_KEY` | with analytics | Public analytics key. |
| `PORT` | no | Port the runtime listens on. Defaults to `3001`. |
| `WANIWANI_API_URL` | no | WaniWani region URL. Defaults to `https://app.waniwani.ai`. |
| `WANIWANI_MCP_URL` | no | Overrides the MCP origin the configuration publishes. |
| `WANIWANI_ANALYTICS` | no | `ingest` reports transcripts to WaniWani, `off` reports nothing. Defaults to `off`, and is refused outright on a runtime serving more than one environment. |
| `AI_GATEWAY_BASE_URL` | no | Overrides the gateway endpoint. Leave unset in production. |
| `WANIWANI_MODEL_CONTEXT_WINDOW_TOKENS` | no | Context window the runtime assumes. Defaults to `32000`. |
| `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | no | Concurrent durable workers. Defaults to `5`. |

Every secret above also accepts a `_FILE` variant, which is what `compose.yaml` uses:
`WANIWANI_API_KEY_FILE=/run/secrets/api_key` reads the value out of the file instead of the
environment.

## Trying it against a local WaniWani

The runtime talks to whatever `WANIWANI_API_URL` points at, so a local app works.

1. Run the app on port 3000, and copy an environment key from its developers page.

2. Point the runtime at it. `compose.yaml` brings its own Postgres, so nothing else is needed.

   ```sh
   mkdir -p .secrets
   printf %s 'wwk_...' > .secrets/api_key
   chmod 600 .secrets/*

   cat > .env <<EOF
   POSTGRES_PASSWORD=$(openssl rand -hex 32)
   WANIWANI_API_URL=http://host.docker.internal:3000
   WANIWANI_AGENT_PORT=4310
   MODEL_API_KEY=            # your own model's key, for a byo environment
   AI_GATEWAY_API_KEY=       # gateway key, for a managed one
   EOF

   docker compose up --build -d --wait
   ```

   `host.docker.internal` is how the container reaches your host on macOS and Windows. On Linux
   use the host's address on the docker bridge. Set `WANIWANI_MCP_URL` the same way when the MCP
   URL the environment publishes is not reachable from inside the container.

3. Open a conversation. The credential is the same environment key.

   ```sh
   KEY=$(cat .secrets/api_key)
   curl -s -X POST http://127.0.0.1:4310/eve/v1/session \
     -H "authorization: Bearer $KEY" \
     -H "content-type: application/json" \
     -H "x-waniwani-visitor: you@example.com" \
     -d '{"message":"hello"}'
   ```

   That answers `{"ok":true,"sessionId":"wrun_…","status":"accepted"}`.

4. Watch the turn. The stream is NDJSON, one runtime event per line, ending at `turn.completed`.

   ```sh
   curl -sN "http://127.0.0.1:4310/eve/v1/session/wrun_…/stream?startIndex=0" \
     -H "authorization: Bearer $KEY"
   ```

   `action.result` carries the tool result your MCP server returned, `_meta` included.
   `message.completed` carries the answer.

5. Send another message to the same conversation:

   ```sh
   curl -s -X POST http://127.0.0.1:4310/eve/v1/session/wrun_… \
     -H "authorization: Bearer $KEY" \
     -H "content-type: application/json" \
     -d '{"message":"and again"}'
   ```

The behaviour worth confirming is the one the cache exists for: publish a new prompt in the
dashboard mid-conversation, wait out the minute, send two more messages, and the second answers on
the new prompt with nothing reloaded.

`docker compose logs -f eve` shows the revalidation passes and any failure the runtime logged.

## Not in this release

A session's visitor is fixed when it is created. A token continuing it has to carry the same
`sub`, because `_meta.visitorId` and every analytics event read the session's initiator. A visitor
who signs in mid-conversation starts a new session.


A failure the runtime cannot recover from ends the session rather than the turn. See the note on
`turn.started` in the README.

Eve has a native skills system. This repository does not ship it.
