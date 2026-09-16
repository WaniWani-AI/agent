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
eve/             the Eve project: the agent, its Dockerfile and its pinned dependencies
fixtures/        a fake MCP server, a fake WaniWani and a fake model, for CI
compose.yaml     the reference deployment: eve + postgres
compose.ci.yaml  the same plus the three fixtures, shaped by ci/*.env
ci/              the two CI stack definitions and a throwaway keypair generator
test/            end-to-end tests that drive the runtime over HTTP
docs/            operator documentation
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
node ci/keygen.mjs

docker compose -f compose.ci.yaml --env-file ci/selfhosted.env up --build --wait
STACK=selfhosted AGENT_ENV_FILE=ci/selfhosted.env bun test test/
docker compose -f compose.ci.yaml --env-file ci/selfhosted.env down -v

docker compose -f compose.ci.yaml --env-file ci/hosted.env up --build --wait
STACK=hosted AGENT_ENV_FILE=ci/hosted.env bun test test/
docker compose -f compose.ci.yaml --env-file ci/hosted.env down -v
```

Checks (a) to (d) run against the self-hosted stack and take about eighty seconds: one waits out
the full revalidation floor and three restart the runtime. Check (h) runs against the hosted stack
and proves the whole hosted path, since the mock WaniWani verifies the Ed25519 service token the
runtime signs. `ci/keygen.mjs` mints that keypair per run, so no private key is committed.

## Pins

`eve@0.52.2`, `@workflow/world-postgres@5.0.0-beta.40`, `ai@7.0.82`, `@ai-sdk/openai@4.0.36`,
`@modelcontextprotocol/sdk@1.30.0`, Node 24. The Postgres World pin is load-bearing: the default
npm tag is incompatible with the Workflow line eve bundles. Do not move any of them without
running the end-to-end suite.
