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

2. Write the two secret files that `compose.yaml` mounts:

   ```sh
   mkdir -p .secrets
   printf %s 'wwk_...' > .secrets/api_key
   openssl rand -hex 32 > .secrets/agent_secret
   chmod 600 .secrets/*
   sudo chown 1000:1000 .secrets/*   # linux only
   ```

   Compose bind-mounts file-backed secrets with the source file's owner and mode,
   and the image runs as UID 1000. A `0600` file owned by anyone else is
   unreadable inside the container and the runtime exits at startup.

   `api_key` is your identity to WaniWani. `agent_secret` is the HMAC secret your website's
   backend signs session tokens with, and the runtime verifies every inbound request against it.

3. Copy `.env.example` to `.env` and fill in `POSTGRES_PASSWORD`.

4. Start it:

   ```sh
   docker compose up --build -d --wait
   curl http://127.0.0.1:3001/eve/v1/health
   ```

## The session token

Every request to the runtime carries `Authorization: Bearer <token>`, an HS256 JWT your backend
mints per visitor. Nothing else is accepted.

| Claim | Value |
| --- | --- |
| `iss` | `waniwani:agent` |
| `aud` | `waniwani-agent-runtime` |
| `sub` | The visitor's id, or the literal `anonymous`. Never empty. |
| `exp` | At most five minutes out. |
| `jti` | Unique per token. |
| `environmentId` | Optional. Only a WaniWani-hosted runtime accepts it. |
| `channelId` | Optional. The channel the conversation is attributed to. |
| `extra` | Optional. A JSON object, as a string, passed through to your MCP server. |

A visitor never sees the secret. Mint the token server-side, per page load.

## Who may address a session

eve authenticates every session-addressed route and authorizes none of them. `routeAuth` runs the
channel's auth function and then hands the request straight to `attachSession(sessionId)`, so a
token that verifies is accepted against any session id it names.

The `turn.started` gate closes the half that changes state. A request continuing someone else's
session must carry the same `environmentId` the session was created with, and, when both sides
name a real visitor rather than `anonymous`, the same `sub`. A mismatch fails the turn.

The half that only reads is still open. `GET /eve/v1/session/:id/stream` and the cancel, clear,
compact and reset routes reach eve before any authored code runs, so a valid token plus a session
id is enough to read a transcript or end a conversation. Session ids are ULIDs and are not
guessable, but they are not a credential either. Closing this needs either the adapter in front of
the runtime to own the boundary, or an ownership check inside eve.

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

## The model

WaniWani resolves the model when it serves the configuration. The runtime never substitutes a
different one.

| Mode | Endpoint | Key |
| --- | --- | --- |
| `managed` | `AI_GATEWAY_BASE_URL`, or the Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| `byo` | The base URL on the payload | The key on the payload, else `MODEL_API_KEY` |

A missing key fails the turn with a message naming the variable. There is no fallback.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `WORKFLOW_POSTGRES_URL` | yes | Postgres holding durable session state. |
| `WORKFLOW_LOCAL_BASE_URL` | yes | How the runtime reaches itself, e.g. `http://eve:3001`. |
| `WANIWANI_AGENT_SECRET` | yes | HMAC secret the session token is signed with. |
| `POSTGRES_PASSWORD` | yes | Read by `compose.yaml`, which refuses to start without it. |
| `WANIWANI_API_KEY` | one of | The environment key (`wwk_…`). Self-hosted deployments set this. |
| `WANIWANI_SERVICE_PRIVATE_KEY` | one of | Ed25519 PKCS8 PEM. WaniWani-hosted runtimes set this instead, and serve whichever environment the session token names. |
| `WANIWANI_REGION` | with the PEM | `us` or `eu`. The audience the service token is minted for. |
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

## Not in this release

A failure the runtime cannot recover from ends the session rather than the turn. See the note on
`turn.started` in the README.

Eve has a native skills system. This repository does not ship it.
