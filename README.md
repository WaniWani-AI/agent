# WaniWani agent

The Eve agent that serves WaniWani website chat. One runtime answers for any environment: it
reads its tenant from the session token, fetches that environment's published prompt, model and
channels from WaniWani, and exposes your MCP server's tools to the model over MCP.

Run it yourself next to your MCP server, or let WaniWani host it. The same image does both; only
the credential differs.

```
eve/          the Eve project: the agent, its Dockerfile and its pinned dependencies
fixtures/     a fake MCP server, a fake WaniWani and a fake model, for CI
compose.yaml  the reference deployment: eve + postgres
compose.ci.yaml  the same, plus the three fixtures
test/         end-to-end tests that drive the runtime over HTTP
docs/         operator documentation
```

Start at [docs/self-hosted-agent.md](docs/self-hosted-agent.md) to deploy it.

## How a turn resolves

A `turn.started` hook is the gate. It reads the tenant from the session token, blocks until that
tenant's configuration and tool list are in memory, and hands the rest of the turn one stable
copy. Instructions, tools and the model all read that copy, so a publish landing mid-turn can
never leave step two running a newer model than the prompt it is executing.

Revalidation runs beside the turn, never in front of it: a conditional `GET` at most once a
minute per tenant, and a failure keeps the copy already in memory.

**One caveat worth knowing.** The plan this repository implements assumes a throwing
`turn.started` hook produces a recoverable `turn.failed`. In eve 0.52.2 it does not: the throw
escapes `turnStep`, the workflow retries the step three times, and the session ends in
`session.failed`. The safety property still holds, since a turn that cannot reach its
configuration never answers, and the one-minute floor means the three retries cost one request
rather than four. What is lost is resumability: that conversation is over, and the next message
starts a new session.

**And one open hole.** eve authenticates session-addressed routes but never authorizes them. The
gate rejects a cross-tenant or cross-visitor continuation, so nothing writes into a session it does
not own. Reading one is still possible for anyone holding a valid token and a session id, because
`GET /eve/v1/session/:id/stream` and the cancel, clear, compact and reset routes answer before any
authored code runs. See "Who may address a session" in the operator doc.

## Running CI locally

```sh
cd eve && npm ci && npx tsc --noEmit && bun test agent && cd ..
docker compose -f compose.ci.yaml up --build --wait
bun test test/
docker compose -f compose.ci.yaml down -v
```

The end-to-end suite takes about ninety seconds. One check waits out the full revalidation floor,
and three restart the runtime.

## Pins

`eve@0.52.2`, `@workflow/world-postgres@5.0.0-beta.40`, `ai@7.0.82`, `@ai-sdk/openai@4.0.36`,
`@modelcontextprotocol/sdk@1.30.0`, Node 24. The Postgres World pin is load-bearing: the default
npm tag is incompatible with the Workflow line eve bundles. Do not move any of them without
running the end-to-end suite.
