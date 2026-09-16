Closes WAN-1147

## Summary

A new repo holding the Eve agent that serves website chat for any environment. It reads its tenant from the session principal, fetches that environment's published configuration through a stale-while-revalidate cache keyed per tenant, exposes the MCP server's tools to the model over MCP directly, resolves the model by one rule, and never runs a turn without its prompt. CI brings the whole stack up against three fixtures and runs real turns.

Part of plan v1.1 (WAN-1078), sub-issue of WAN-1074. PR 2 (WAN-1146, app#1189) delivers the config route this reads.

## 🚨 The ticket states one Eve fact that eve 0.52.2 does not deliver

> A throwing `session.started` or `turn.started` hook yields `turn.failed`.

It does not. A hook throw at `turn.started` escapes `turnStep`, the workflow retries that step three times, and the session ends in `session.failed`. Reproduced against the fixture stack: four `turn.started` events, no `message.received`, then `session.failed` carrying the hook's message. The cause is in `execution/workflow-steps.js`, where `handleEvent` awaits `dispatchStreamEventHooks` inside `emitTurnPreamble`, and in `harness/tool-loop.js`, where `emitRecoverableFailedTurn` is reached only from the model-call error path. Nothing converts a hook throw into a recoverable turn.

The gate is still the right place and the design still holds where it matters. A turn that cannot reach its configuration never answers, and the one-minute floor means the three retries cost one request rather than four. What is lost is resumability: that conversation is over and the visitor's next message starts a new session. This is written up in the README and the doc, and check (d) asserts the behaviour that actually happens.

It matters beyond this PR, because WAN-1074's handoff calls the asymmetry "the whole reason for the recommended fix" and three tickets lean on it. Worth deciding whether PR 4 should catch at the gate and answer with a canned apology instead.

Two smaller disagreements, both resolved in the code and flagged here:

- **`turnCount` from `ctx.messages`.** eve hands a tool resolver an empty `messages` array at `turn.started` (`emitTurnPreamble` calls `handleEvent(event)` with no second argument), so counting user messages there always yields zero. It is derived from the turn sequence instead, which is the same number, and the e2e check pins it.
- **`instructions/mcp-app.ts` is dropped.** The cache entry the ticket fixes is `{ config, tools, etag, checkedAt }`, which has no room for the MCP server's `initialize` instructions. The client exposes them and putting them back costs about twelve lines. Say so in review and I will.

## 🚨 eve authorizes no session-addressed route

Every route under `/eve/v1/session/:id` runs `routeAuth` and then hands the request to
`attachSession(sessionId)`. Nothing compares the caller to the session. Confirmed by reading
`eve-channel/index.js`, and it matters here because `tenantOf` reads the *initiator's*
`environmentId`: a token valid for one environment could post into another environment's session
and be answered using that environment's prompt, model and MCP server.

The `turn.started` gate now rejects a continuation whose `environmentId` differs from the
session's, or whose `sub` differs when both sides name a real visitor rather than `anonymous`.
Seven cases pin it.

The read-only half stays open. `GET /eve/v1/session/:id/stream`, plus cancel, clear, compact and
reset, answer before any authored code runs, so a valid token and a session id are enough to read
a transcript or end a conversation. Session ids are ULIDs and are not guessable, but they are not
a credential either, and they travel to the browser. Closing it needs either PR 4's adapter to own
that boundary or an ownership check inside eve. Written up under "Who may address a session".

## Files moved from the branch, one line each

| File | What changed |
| --- | --- |
| `eve/package.json` | Added `@modelcontextprotocol/sdk`, typescript and the type packages; added `test` and `typecheck` scripts; renamed the package. |
| `eve/package-lock.json` | Regenerated against the new dependency set. |
| `eve/Dockerfile` | Copies `tsconfig.json` alongside `agent/`. |
| `eve/entrypoint.sh` | The `_FILE` loop now covers six secrets and no installation credential, and assigns through `export name=value` so a PEM survives. |
| `eve/agent/agent.ts` | The model rule, read off the turn snapshot. No credential fetch, no I/O in the resolver. |
| `eve/agent/channels/eve.ts` | The shared-token comparison became one `verifyJwtHmac` call. |
| `eve/agent/hooks/session-config.ts` | Became the `turn.started` gate: resolve the tenant, warm the cache, validate the model credential, snapshot. Releases the snapshot when the turn ends. |
| `eve/agent/hooks/analytics.ts` | Gated on `WANIWANI_ANALYTICS=ingest`. Channel and visitor come from the principal, not the configuration. No `isTest`, no deployment id. Usage is attributed to the model id from `step.started` rather than whatever is cached at completion. |
| `eve/agent/instructions/waniwani.ts` | Reads the turn snapshot instead of calling the cache itself. |
| `eve/agent/instructions/mcp-app.ts` | Deleted. See above. |
| `eve/agent/lib/published.ts` | The three module variables became one `Map` keyed by tenant. `publishedFresh` is gone, because revalidation is now always off the turn path. A cold failure shares the one-minute floor and reports its last error. |
| `eve/agent/lib/session-config.ts` | The new payload shape (`environmentId`, `mcpUrl`, `webSearch`, `channels[]`). The credential fetch, its cache and `configVersion` are deleted. `baseUrl` is required for `byo` only. |
| `eve/agent/lib/mcp-catalog.ts` | The adapter URL and the service token are gone. One MCP client per tenant, dialled with `StreamableHTTPClientTransport`, dropped and redialled when a call fails or the published `mcpUrl` moves. |
| `eve/agent/tools/mcp.ts` | Calls `callTool({ name, arguments, _meta })` directly. `toModelOutput` keeps `_meta` out of the model's view while the durable result holds it for PR 4. |
| `eve/agent/lib/json.ts` | Unchanged. |
| `eve/agent/lib/published.test.ts` | Moved and rewritten for the map. Every case that still applied survived; the credential cases went with the credential. |
| `compose.yaml` | Two services rather than three, since the MCP server is no longer built here. Publishes eve on loopback. |
| `docs/self-hosted-agent.md` | "How configuration reaches a turn" and "Environment" rewritten to this contract. The demo cookie section and the `/agent/v1` route table are gone; PR 4 owns those. |

New in this repo: `eve/agent/lib/tenant.ts` (tenant resolution and the Ed25519 service-token signer), `eve/agent/lib/model.ts` (the model rule as a pure function), `eve/agent/lib/turn-snapshot.ts`, `eve/tsconfig.json`, `fixtures/**`, `compose.ci.yaml`, `test/e2e.test.ts`, `.github/workflows/ci.yml`, `README.md`, `.env.example`.

## How to see it working

```
$ docker compose -f compose.ci.yaml up --build --wait
$ bun test test/

 5 pass
 0 fail
 20 expect() calls
Ran 5 tests across 1 file. [79.02s]
```

One session, end to end, with the fixture MCP server recording what it received:

```
turn.started       {"sequence":0,"turnId":"turn_0"}
message.received   {"message":"hello",...}
step.started       {"modelId":"openai/fixture/model","stepIndex":0}
actions.requested  {"actions":[{"callId":"call_1","input":{"text":"hello"},"toolName":"echo"}]}
action.result      {"result":{"kind":"tool-result","output":{"_meta":{"openai/outputTemplate":"ui://views/ext-apps/echo.html"},"content":[{"type":"text","text":"echo: hello"}]}}}
step.started       {"modelId":"openai/fixture/model","stepIndex":1}
message.completed  {"finishReason":"stop","message":"the fixture answered"}
turn.completed     {"sequence":0,"turnId":"turn_0"}

$ curl -s http://127.0.0.1:3002/_calls
{"calls":[{"name":"echo","arguments":{"text":"hello"},"_meta":{
  "waniwani/sessionId":"wrun_01M2MGDJSRNASYCG5B67XEG0JH",
  "waniwani/turnCount":1,
  "waniwani/channelId":"33333333-3333-4333-8333-333333333333",
  "waniwani/source":"website"}}]}
```

`waniwani/visitorId` is absent because the token's `sub` is `anonymous`, which is the rule. The tool result keeps `_meta` in durable state while the model saw only `echo: hello`.

## Gates

```
npx tsc --noEmit (eve)     clean
bun test agent (eve)       26 pass | 0 fail
bun test test/             5 pass | 0 fail
docker compose up --wait   postgres, mcp, app, model, eve all healthy
grep -rn "installation\|wwi_\|agent_token\|/agent/v1" eve/agent
                           (no matches)
```

Source budget: 869 lines in `eve/agent` against a target of about 700, 232 in `fixtures/` against about 300. Under the stop-and-report threshold on both.

`ci.yml` has never run, because the repo was created for this PR and the workflow lands with it. Its first run is this PR.

## Review focus

- **The gate's ordering assumption.** Everything rests on hooks running before tool and instruction resolvers. Confirmed in eve 0.52.2's `handleEvent`, which awaits `dispatchStreamEventHooks` first and `dispatchDynamicInstructionEvent` last. If that ordering ever changes, a failed cold load goes back to silently dropping the prompt and the guardrail suffix, which is the dangerous bug from WAN-1074's handoff.
- **`resolveModelAccess` is called twice per turn**, once by the gate to fail the turn on a missing key and once by the `step.started` resolver to build the provider. It is pure, so the second call cannot fail where the first did not. That is what keeps the credential check out of a scope where a throw would kill the session.
- **The turn snapshot is a `Map` keyed by session id**, released on `turn.completed`, `turn.failed` and `turn.cancelled`. A turn that dies without any of those leaves one entry behind until the process restarts.
- **`webSearch` is parsed and unused.** It is on the payload and nothing in this ticket's steps wires it to a tool.
- **Check (d) restarts the runtime to get a cold tenant.** In CI there is one tenant key, `self`, so an outage cannot make a brand-new session cold without one. The check asserts both halves the ticket asks for: an existing session keeps answering off the stale copy, and a cold one fails loudly instead of answering.
- **Check (b) waits out the full sixty-second floor**, then spends one turn kicking the background pass before asserting on the next. A publish lands on the turn after the revalidation, which is what "always off the turn path" costs.
- **Tests here were written by the same model that wrote the code.** The app's tester-subagent rule does not exist in this repo, per the ticket.
- **What the review pass changed.** `/codex:review` raised six defects and all six were real. Beyond the authorization finding above: `tools/list` pagination was dropped after the first page, so an MCP server with a paged catalog silently lost tools; a cancelled or timed-out tool call closed the MCP client shared by every session on that tenant, failing unrelated visitors; analytics delivery was awaited inside a hook with no deadline, so a stalled ingest endpoint could hold a conversation open; the reference `compose.yaml` never forwarded `AI_GATEWAY_API_KEY`, so a managed payload could not resolve a credential there at all; and the enrollment steps wrote `0600` secret files that the image's own `USER node` cannot read on Linux. An earlier self-review fixed three more: two empty-string env overrides that compose actually produces, an MCP client cached per tenant but never per endpoint, and an `entrypoint.sh` eval that mangles any `_FILE` secret carrying a space or a newline.

## Manual steps after merge

None in this repo. `AGENT_RUNTIME_SERVICE_PUBLIC_KEY` on both production Vercel projects is PR 2's step, and nothing here can authenticate against a region until it is set.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
