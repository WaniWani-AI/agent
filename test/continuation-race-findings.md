# PR #2 continuation diagnostic

These are historical investigation notes. The fix is now implemented locally; see the final section and `README.md` for the current regression commands.

Tested commit `6c6f04d64df9ac777ebeb841f118935c9491cdae`, with the running container reporting Eve `0.52.2`. No application or adapter implementation changes were made.

The live diagnostic calls the PR's real `runTurn`, against its self-hosted PostgreSQL CI stack. A controlled OpenAI-compatible model emits distinguishable `ANSWER_A` and `ANSWER_B` responses. An independent reader records Eve's real session events and the model records its actual request messages. This tests runtime and adapter behavior, not a real model's answer quality.

## Results

| Scenario | Repetitions | Result |
| --- | --- | --- |
| A settles before the adapter reads the tail | 1 | Adapter correctly returns `ANSWER_B`. |
| A settles between the adapter's tail read and follow-up POST | 3 | Eve generates `ANSWER_B`; adapter returns `ANSWER_A` and closes before B. |
| B arrives while A is actively streaming | 3 | Adapter returns remaining A deltas and closes before B. Eve eventually emits cancellation and a replacement turn, but the replacement model input omits A. |

All 21 existing adapter unit tests passed (122 assertions). They do not exercise the live continuation race.

## Exact race sequence

The test pauses delivery of the real tail-read response to the adapter, retaining its original header, until A emits `session.waiting`. It changes scheduling only; it does not fabricate runtime responses or events.

1. Adapter captures tail index `4` (`message.appended`, `turn_0`).
2. A completes; its events occupy indices `5`–`8`, ending in `session.waiting`.
3. Follow-up POST is accepted with `{ok: true, sessionId, status: "accepted"}` and no turn ID.
4. Adapter reads from index `5`, projects A's `message.completed` into `ANSWER_A`, and closes at index `8`.
5. B's `turn.started` is index `9`, `message.received` is `10`, and its answer is emitted after that. The browser-facing adapter has already stopped.

The race is reproducible. These forced repetitions demonstrate the failure path; they do not estimate its frequency in production.

## Steering observations and limitation

The unmodified adapter sends no explicit policy, so Eve uses its default `steer` policy. Each of the three completed active-follow-up cases emitted a distinct `turn_1` and fresh `turn.started` and `message.received` events. The earlier claim that steering cannot emit these markers is contradicted by this test.

However, the local stack did not promptly interrupt the model response. In preliminary runs, keeping A open (including one run emitting additional tokens every 50 ms) resulted in a 30-second adapter timeout without cancellation. In the completed diagnostic, A continues emitting tokens for two seconds after the follow-up is accepted, then the test lets its model response end. Eve emits A's completion and waiting events, then cancellation and another waiting event, then starts B.

In all three cases the complete replacement model input was a system instruction plus `FOLLOW_UP_B steer N`. `INITIAL_A steer N` was absent from every role. The settled control and forced-race cases retained both inputs. Thus preserving steering as the intended behavior also requires investigating runtime interruption and retention of the interrupted user input; adapter event filtering alone would not establish that behavior.

## Reproduce

Use an isolated stack with host ports 3001–3004 available; the diagnostic model uses host port 13005. The Docker host must resolve `host.docker.internal` (tested with Docker Desktop on macOS).

```sh
docker compose -p waniwani-pr2-race -f compose.ci.yaml --env-file ci/selfhosted.env up --build --wait
bun run test/continuation-race.repro.ts
docker compose -p waniwani-pr2-race -f compose.ci.yaml --env-file ci/selfhosted.env down -v
```

The script writes event traces and full replacement model inputs to `/tmp/agent-pr2-race-results.json`. Its assertions intentionally document the existing bug; it is a diagnostic, not a regression test asserting fixed behavior. It restores the fixture model configuration after running.

## Follow-up: a verified fix direction

The application implementation remains unchanged. The following candidate was tested from copies under `/tmp/eve-investigation`, using the same real PostgreSQL runtime and adapter test.

### 1. Correlate deliveries instead of guessing from the stream cursor

Upgrade the pinned runtime from Eve 0.52.2 to the tested Eve 0.53.0, with its required AI SDK 7.0.93. Keep `turnPolicy: "steer"` explicit on continuations. Eve 0.52.3 introduced server-issued `deliveryId` in the POST response and `event.meta.deliveryIds` on stream events ([upstream PR #3096](https://github.com/vercel/eve/pull/3096)).

Change `continueEveSession` to return both the captured stream cursor and the accepted delivery ID. The cursor is only a reading optimization. Filter events by delivery ID, following the upstream client implementation: skip earlier or unrelated deliveries, including their waiting boundaries. End the response at the boundary belonging to the accepted delivery. Handle terminal session failures while waiting as errors rather than hanging. Require a valid delivery ID; silently falling back would restore the race.

This closes the read-tail/POST race without changing chat interaction to queueing and without depending on `turn.started` or matching user text.

### 2. Preserve the original user input when interruption arrives late

Eve 0.52.2 rolls back to pre-step context when cancellation is observed just after a successful model step. In the observed case, that drops the first user message. Eve 0.53.0 retains the successful step result at this boundary (upstream commit `2b2ad19d937ea2ad3ea2b3adb4fdd54efb0b5c64`, [PR #3034](https://github.com/vercel/eve/pull/3034)).

Eve 0.53.0 plus delivery filtering passed all seven settled/race/steer cases and retained both user inputs. It still waited for A's model call to end before starting B, so upgrading alone does not meet the desired behavior.

### 3. Allow cancellation while a model step is running

The PostgreSQL world serializes workflow invocations for each run. The bundled workflow core executes new steps inline and waits for them before returning its workflow invocation. When a long model step is inline, the cancellation replay waits behind that model call. The cancellation request arrives promptly, but the model's durable abort signal is delivered only after generation ends.

Keep per-run serialization: removing it risks concurrent replay problems. Instead, allow steps to execute as separate step jobs so the workflow invocation returns and cancellation can be processed.

The tested prototype adds support for `WORKFLOW_MAX_INLINE_STEPS=0` to Eve's bundled workflow core and sets that value on the PostgreSQL runtime. The existing parser rejects zero, so setting the environment variable alone does not work. `WORKFLOW_TURBO=0` also does not disable inline step execution.

The exact experimental change, in `eve/dist/src/compiled/@workflow/core/runtime.js`, was to add the following early return in the function that parses `WORKFLOW_MAX_INLINE_STEPS`:

```js
const value = process.env.WORKFLOW_MAX_INLINE_STEPS;
if (value === "0") return 0;
// Existing parser follows.
```

For a production change, implement this as a supported upstream setting or a narrowly scoped, version-checked maintained dependency patch applied during the runtime build, with a regression test. The experiment modified a temporary dependency copy; it is not a production patch ready to merge. Disabling inline steps adds queue round trips: in this local test, settled/race replacement starts were roughly 1.2–1.4 seconds after acceptance.

### Verified candidate results

| Candidate | Right response in all 7 cases | Both user inputs retained | Prompt interruption |
| --- | --- | --- | --- |
| Eve 0.53.0 + delivery filtering | Yes | Yes | No; waits for A to finish |
| Above + separate step execution | Yes | Yes | Yes; 137–856 ms in 3 active-answer cases |

A further three active-answer runs also explicitly checked that the original model HTTP connection was aborted. All passed; replacement started in 158–832 ms, with A still held open by the fixture and both A and B present as user messages. The replacement context was system instruction, original user message, and follow-up user message, with the interrupted assistant answer removed. These are controlled local timings, not production latency promises.

### Additional cancellation ownership change

Code inspection found that `express.ts` calls unscoped `cancelTurn(sessionId)` when an old HTTP response closes; `eve-client.ts` sends `{}` to the cancel route. That can target a newer current turn. Scope automatic cleanup to the turn owned by that response, using the turn ID learned from its delivery-correlated events, and send `{turnId}` to Eve. Handle closure before that ID is known without falling back to cancelling the whole session. The upstream client also scopes response cancellation by turn ID. This additional overlap scenario was identified from code and should get its own regression test; it was not exercised by the current model/adapter diagnostic.

### Acceptance tests for implementation

- Previous answer ends exactly between tail read and follow-up POST: only B reaches B's response.
- Follow-up arrives during a gated model call: old model connection aborts and replacement starts before gate release, with both user messages.
- Follow-up arrives just as the model finishes: neither user message is lost.
- Old browser response closes after replacement starts: replacement survives.
- Rapid A/B/C follow-ups, cancellation before delivery events arrive, and session failure before a delivery begins terminate predictably without cancelling another response's turn or hanging.

Candidate diagnostic commands and temporary artifacts:

```sh
# Build the temporary Eve 0.53.0 / AI 7.0.93 candidate with inline-step opt-out patch.
docker compose -p waniwani-pr2-race -f compose.ci.yaml \
  -f /tmp/eve-investigation/upgrade.compose.yaml \
  -f /tmp/eve-investigation/inline-off.compose.yaml \
  --env-file ci/selfhosted.env up -d --no-deps --build --wait eve

EXPECT_FIXED=1 EXPECT_INTERRUPT=1 STEER_RELEASE_MS=25000 \
  ADAPTER_CORE=/tmp/eve-investigation/adapter/src/core.ts \
  bun run test/continuation-race.repro.ts

EXPECT_FIXED=1 EXPECT_INTERRUPT=1 EXPECT_TRANSPORT_ABORT=1 \
  STEER_RELEASE_MS=25000 RACE_CASES=steer \
  ADAPTER_CORE=/tmp/eve-investigation/adapter/src/core.ts \
  bun run test/continuation-race.repro.ts
```

Raw candidate traces: `/tmp/eve-investigation/upgrade-default-results.json`, `/tmp/eve-investigation/inline-off-results.json`, and `/tmp/eve-investigation/transport-results.json`. Temporary adapter candidate: `/tmp/eve-investigation/adapter/src/eve-client.ts`. Dependency patch prototype: `/tmp/eve-investigation/runtime/patch-cancellation.mjs`.

## Implementation

The adapter now selects events by the continuation's accepted delivery ID, explicitly requests steering, and exposes a response-bound `cancel()` for disconnect cleanup. Cleanup resolves the owning turn even before its first event reaches the UI, and only the latest delivery in a batched replacement may cancel that shared turn.

The runtime pins Eve 0.53.0 and AI 7.0.93. Its build applies the checked `eve/scripts/patch-workflow.mjs` patch and the runtime uses `WORKFLOW_MAX_INLINE_STEPS=0` to keep cancellation runnable during a model step.

The old diagnostic was converted into `test/continuation.ts`: its assertions now require correct behavior, prompt model-connection abort, preservation of input, and safe rapid A/B/C follow-ups. CI runs it against the self-hosted Docker stack. Adapter unit tests cover delivery filtering, stream termination, and cancellation ownership; a separate Node test exercises an actual streaming browser disconnect using the built adapter. The Eve upgrade also changes the outage assertion from `session.failed` to `turn.failed`, with the direct configuration error instead of the old retry wrapper.

Final validation: 47 agent unit tests, 33 adapter unit tests, the native Node disconnect regression, seven live settled/race/steer scenarios plus rapid A/B/C with C held open during old-response cleanup, all eight self-hosted E2E checks (the upgraded outage assertion verified separately), and both hosted E2E checks passed. Typechecks, runtime Docker build, adapter build and package dry-run also passed. The disposable test stack was removed.

## Adversarial review follow-up

A subagent found two defects in the initial fix, both addressed:

- Cancellation still starved when all five model worker slots were occupied. A live reproduction kept five model streams open; the follow-up remained blocked until those streams were released. `eve/scripts/patch-postgres.mjs` now reserves two workers for workflow replay and Eve's cancellation-forwarding step while preserving the existing serialization and idempotency handling. The live suite now holds all five model streams open and requires the selected turn to be interrupted without stopping the other four.
- The cleanup deadline covered ownership discovery but not the cancellation POST. The adapter now shares one deadline through discovery, backoff, the POST and its error body, retaining the original stream-attachment error if cleanup fails. New HTTP tests cover stalled response headers, a stalled error body and cancellation during retry backoff.

The same subagent reviewed the reserved-worker patch and found no further actionable defects.

The reserved-worker fix passed the live saturated-pool regression after using the observed compiled identifier `step//eve@0.53.0//forwardTurnCancellationStep`. All seven earlier continuation cases and the rapid A/B/C case passed as well. Standalone cancellation now has the same default ten-second bound; response cleanup keeps its original shared deadline.

Post-review validation passed: 38 adapter tests (including five new timeout/backoff cases), 47 agent tests, native Node disconnect regression, nine live continuation cases (including saturated workers), all eight self-hosted E2E checks and both hosted E2E checks. Typechecks, build and patch idempotence checks passed. The review fixes remain local and uncommitted.
