# WaniWani agent

The Eve agent that serves WaniWani website chat. It reads its tenant from the session principal,
fetches that environment's published prompt, model and channels from WaniWani, and exposes your
MCP server's tools to the model over MCP.

Run it yourself next to your MCP server, or let WaniWani host it. The same image does both, and
the credential is what picks the shape. A self-hosted deployment holds its environment's own key,
serves that one environment, and takes the visitor from a header its backend sets. The hosted
runtime holds an HMAC secret instead, takes one short-lived JWT per visitor, and serves whichever
environment that token names. Setting both, or neither, refuses to start.

```
eve/               the Eve project: the agent, its Dockerfile and its pinned dependencies
packages/adapter/  @waniwani/agent-adapter: the turn stream and the /agent/v1 router
fixtures/          a fake MCP server, a fake WaniWani and a fake model, for CI
compose.yaml       the reference deployment: eve + postgres
compose.ci.yaml    the same plus the three fixtures, shaped by ci/*.env
ci/                the two CI stack definitions and a throwaway keypair generator
test/              end-to-end tests that drive the runtime over HTTP
docs/              operator documentation
```

Start at [docs/self-hosted-agent.md](docs/self-hosted-agent.md) to deploy it.

## The adapter package

`@waniwani/agent-adapter` is what a browser talks to. It turns a runtime session into the AI SDK
UI message stream the WaniWani SDK's chat embed already reads, and it ships the routes that embed
expects. It depends on `jose` and nothing else; `express`, `cors` and `@modelcontextprotocol/sdk`
are peers, which an MCP server built on Skybridge already has.

**`@waniwani/agent-adapter/core`** is framework-free, and is what the WaniWani-hosted chat route
calls in process.

```ts
mintSessionToken({ secret, sub, environmentId?, channelId?, sid? }): Promise<string>
runTurn({ eveUrl, credential, visitorId?, message, sessionId?, clientContext?, extra?, signal? })
cancelTurn({ eveUrl, credential, sessionId }): Promise<void>
runtimeHealth({ eveUrl, credential }): Promise<unknown>
encodeSse(chunks): ReadableStream<Uint8Array>
```

`runTurn` answers `{ sessionId, chunks, cancel }` as soon as the runtime has taken the turn, and the
chunks arrive as the model writes them. `credential` is the environment key on a self-hosted
deployment. On the hosted one it is a function, because a hosted token names the session it may
address and the adapter only learns that id after the session exists. Call the returned
`cancel()` for disconnect cleanup: it targets only that response's turn. The standalone
`cancelTurn({ sessionId, ... })` intentionally stops the session's current turn (the Stop button).
Follow-ups use `turnPolicy: "steer"` and filter stream events by the accepted delivery ID, so
an earlier answer finishing during submission cannot close the new response. Cancellation uses
a ten-second deadline; response cleanup shares that budget across ownership discovery,
retries, and the cancellation request, preserving the original connection error if cleanup fails.

**`@waniwani/agent-adapter/express`** is the router an MCP server mounts beside its own `/mcp`.

```ts
app.use("/agent/v1", agentRouter({ eveUrl, apiKey, publicKey, allowedOrigins, title, mcpLoopbackUrl }))
```

It serves `POST /` (the turn), `POST /cancel`, `GET /config`, `GET /tools`, `POST /tool`,
`GET /resource`, `POST /events` and `GET /health`. Browsers present the environment's public key,
compared in constant time; `GET /resource` also takes it as `?token=`, because an iframe navigates
by GET and cannot carry a header. Every non-GET request has to carry an `Origin` on the allowlist,
and a client gets sixty requests a minute. The router presents the environment key to the runtime,
and never the browser's key.

| Option | Template variable |
| --- | --- |
| `eveUrl` | `WANIWANI_AGENT_EVE_URL`, which is also the switch: unset, nothing mounts |
| `apiKey` | `WANIWANI_API_KEY`, the environment key the server already holds |
| `publicKey` | `WANIWANI_PUBLIC_KEY` |
| `allowedOrigins` | `WANIWANI_ALLOWED_ORIGINS`, comma separated |
| `title` | The app's own title |
| `mcpLoopbackUrl` | This process's own `/mcp` |

`POST /events` forwards widget analytics to `WANIWANI_API_URL` with the public key, so the
variable the rest of the server reads for the region is the one the router uses too.

## How a turn resolves

A `turn.started` hook is the gate. It reads the tenant from the session token, blocks until that
tenant's configuration and tool list are in memory, and hands the rest of the turn one stable
copy. Instructions, tools and the model all read that copy, so a publish landing mid-turn can
never leave step two running a newer model than the prompt it is executing.

Revalidation runs beside the turn, never in front of it: a conditional `GET` at most once a
minute per tenant, and a failure keeps the copy already in memory.

A configuration failure in the `turn.started` hook produces `turn.failed`. The turn never
answers without its configuration; warm sessions can keep using the cached copy during an
outage. The one-minute retry floor prevents repeated failures from flooding the configuration
service.

**Who may address a session.** eve authenticates session-addressed routes but never authorizes
them, so the hosted token carries a `sid` claim naming the one session it may touch and the channel
rejects a mismatch before eve dispatches. That covers the stream and the control routes, not just
follow-up turns. The self-hosted key holder speaks for the whole environment and needs no such
separation. See "Who may address a session" in the operator doc.

**And one narrow window.** eve does not re-emit `turn.started` for a turn it resumes after a
restart, so the snapshot is rebuilt from the tenant's current configuration rather than the one
the turn began on. eve keeps the durable instructions and tool metadata, so a publish landing in
that window can pair an older prompt with a newer model for the rest of that turn. Persisting the
snapshot would fix it, and the ticket rules out holding configuration in durable state.

## Running CI locally

```sh
cd eve && npm ci && npx tsc --noEmit && bun test agent && cd ..
cd packages/adapter && npm ci && npx tsc --noEmit && bun test test && npm run build && npm run test:disconnect && cd ../..
node ci/keygen.mjs

docker compose -f compose.ci.yaml --env-file ci/selfhosted.env up --build --wait
bun run test/continuation.ts
STACK=selfhosted AGENT_ENV_FILE=ci/selfhosted.env bun test test/e2e.test.ts
docker compose -f compose.ci.yaml --env-file ci/selfhosted.env down -v

docker compose -f compose.ci.yaml --env-file ci/hosted.env up --build --wait
STACK=hosted AGENT_ENV_FILE=ci/hosted.env bun test test/e2e.test.ts
docker compose -f compose.ci.yaml --env-file ci/hosted.env down -v
```

Checks (a) to (g) run against the self-hosted stack and take about ninety seconds: one waits out
the full revalidation floor and four restart a container. (e) to (g) drive the adapter, which the
MCP fixture mounts on `/agent/v1` under the same env var the template will use. They sit ahead of
(d), because (d) leaves the runtime holding no configuration on purpose and the next cold turn is
refused for a minute after that.

Check (h) runs against the hosted stack and proves the whole hosted path, since the mock WaniWani
verifies the Ed25519 service token the runtime signs. `ci/keygen.mjs` mints that keypair per run,
so no private key is committed. The router stays unmounted there: it speaks for a whole
environment with that environment's key, which a hosted runtime does not hold.

## Pins

`eve@0.53.0`, `@workflow/world-postgres@5.0.0-beta.40`, `ai@7.0.93`, `@ai-sdk/openai@4.0.36`,
`@modelcontextprotocol/sdk@1.30.0`, `jose@6.1.0`, Node 24. The Postgres World pin is load-bearing:
the default npm tag is incompatible with the Workflow line eve bundles. Do not move any of them
without running the end-to-end suite.

The image and the package are versioned together, because the adapter reimplements the runtime's
wire protocol over `fetch` rather than importing its client.

The runtime build applies checked patches in `eve/scripts/` to these exact versions and runs
with `WORKFLOW_MAX_INLINE_STEPS=0`. PostgreSQL serializes workflow invocations; running a model
step inline would hold that invocation open and block the replay delivering cancellation.
Separate step jobs let a follow-up interrupt generation promptly. The Workflow patch enables zero
(the bundled parser otherwise rejects it), is idempotent, and fails on an Eve upgrade until
reviewed. Keep the setting when running the built runtime outside Docker; `npm start` sets it.
The Postgres patch routes workflow replays and Eve's cancellation-forwarding step to a control
task with two reserved workers, in addition to the configured ordinary worker pool. Without
reserved capacity, model calls filling the pool would also block cancellation. Both pools
share the existing per-run serialization and duplicate-message protection.
These changes add queue round trips and two worker slots; retain the live interruption and
saturation tests when upgrading either dependency or changing runtime concurrency.

`bun run test/continuation.ts` exercises the real self-hosted stack against a gated model on
host port 13005. It forces the tail-read/POST race and checks that steering aborts the old model
connection and preserves both user messages. It also checks rapid A/B/C follow-ups and late
cleanup of earlier responses, and interruption with all five model workers occupied. Compose maps `host.docker.internal` for Linux CI.
