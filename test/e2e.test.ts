import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, expect, test } from "bun:test";

const EVE = process.env.EVE_URL ?? "http://127.0.0.1:3001";
const APP = process.env.APP_URL ?? "http://127.0.0.1:3004";
const MCP = process.env.MCP_URL ?? "http://127.0.0.1:3002";
const MODEL = process.env.MODEL_URL ?? "http://127.0.0.1:3003";
const SECRET = process.env.WANIWANI_AGENT_SECRET ?? "ci-agent-secret";
const ENV_FILE = process.env.AGENT_ENV_FILE ?? "ci/selfhosted.env";
const HOSTED = process.env.STACK === "hosted";
const ENVIRONMENT_ID = "11111111-1111-4111-8111-111111111111";

// Reached from inside the compose network, not from the test's own host ports.
const BYO_MODEL = {
	mode: "byo",
	provider: "litellm",
	modelId: "fixture/model",
	baseUrl: "http://model:3003/v1",
	supportsStructuredOutputs: false,
	providerOptions: null,
};

type StreamEvent = { type: string; data?: Record<string, unknown> };

function base64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

/**
 * The self-hosted stack proves itself with the environment key it already holds.
 * The hosted stack takes one short-lived HS256 token per visitor.
 */
function credential(claims: Record<string, unknown> = {}): string {
	if (!HOSTED) {
		return "wwk_test";
	}
	const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			iss: "waniwani:agent",
			aud: "waniwani-agent-runtime",
			sub: "anonymous",
			environmentId: ENVIRONMENT_ID,
			jti: randomUUID(),
			exp: Math.floor(Date.now() / 1000) + 120,
			...claims,
		}),
	);
	const signature = createHmac("sha256", SECRET)
		.update(`${header}.${payload}`)
		.digest("base64url");
	return `${header}.${payload}.${signature}`;
}

async function control(patch: Record<string, unknown>): Promise<void> {
	const response = await fetch(`${APP}/_control`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	expect(response.ok).toBe(true);
}

async function readStream(
	sessionId: string,
	token: string,
	startIndex: number,
): Promise<StreamEvent[]> {
	const response = await fetch(
		`${EVE}/eve/v1/session/${sessionId}/stream?startIndex=${startIndex}`,
		{ headers: { authorization: `Bearer ${token}` } },
	);
	if (!response.ok || !response.body) {
		throw new Error(`stream failed (${response.status})`);
	}

	const events: StreamEvent[] = [];
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) {
					const event = JSON.parse(line) as StreamEvent;
					events.push(event);
					if (
						event.type === "turn.completed" ||
						event.type === "turn.failed" ||
						event.type === "session.failed"
					) {
						return events;
					}
				}
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return events;
}

async function startSession(
	message: string,
	token: string,
): Promise<{ sessionId: string; events: StreamEvent[] }> {
	const response = await fetch(`${EVE}/eve/v1/session`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ message }),
	});
	if (!response.ok) {
		throw new Error(`create session failed (${response.status})`);
	}
	const { sessionId } = (await response.json()) as { sessionId: string };
	return { sessionId, events: await readStream(sessionId, token, 0) };
}

async function sendTurn(
	sessionId: string,
	message: string,
	token: string,
): Promise<StreamEvent[]> {
	const before = await fetch(
		`${EVE}/eve/v1/session/${sessionId}/stream?startIndex=0&includeTailIndex=1`,
		{ headers: { authorization: `Bearer ${token}` } },
	);
	const tail = Number(before.headers.get("x-eve-stream-tail-index") ?? 0);
	await before.body?.cancel().catch(() => {});

	// eve answers 409 `session_not_active` until the previous turn has parked.
	let delay = 250;
	for (let attempt = 0; ; attempt += 1) {
		const response = await fetch(`${EVE}/eve/v1/session/${sessionId}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ message }),
		});
		if (response.ok) break;
		if (response.status !== 409 || attempt >= 5) {
			throw new Error(`turn failed (${response.status}): ${await response.text()}`);
		}
		await Bun.sleep(delay);
		delay *= 2;
	}
	return await readStream(sessionId, token, tail);
}

async function restartEve(): Promise<void> {
	const proc = Bun.spawn([
		"docker",
		"compose",
		"-f",
		"compose.ci.yaml",
		"--env-file",
		ENV_FILE,
		"restart",
		"eve",
	]);
	expect(await proc.exited).toBe(0);
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const health = await fetch(`${EVE}/eve/v1/health`).catch(() => null);
		if (health && health.status < 500) return;
		await Bun.sleep(1000);
	}
	throw new Error("eve did not come back");
}

function expectCompleted(events: StreamEvent[]): void {
	const last = events.at(-1);
	if (last?.type !== "turn.completed") {
		throw new Error(
			`expected turn.completed, got ${last?.type}: ${String(last?.data?.message).slice(0, 300)}`,
		);
	}
}

async function seenByModel(): Promise<
	Array<{ authorization: string | null; system: string; tools: string[] }>
> {
	const response = await fetch(`${MODEL}/_seen`);
	return ((await response.json()) as { seen: [] }).seen;
}

const onSelfHosted = test.skipIf(HOSTED);
const onHosted = test.skipIf(!HOSTED);

beforeAll(async () => {
	await control({
		failing: false,
		model: HOSTED ? { mode: "managed", modelId: "openai/test" } : BYO_MODEL,
		instructions: "You are a fixture assistant. Always call the echo tool first.",
	});
	// Cold, so the first turn reads the state this run set rather than the last one's.
	await restartEve();
}, 240_000);

onSelfHosted("(a) a first turn calls echo with _meta.sessionId and streams to turn.completed", async () => {
	await fetch(`${MCP}/_calls`, { method: "DELETE" });
	const token = credential();
	const { sessionId, events } = await startSession("hello", token);

	expectCompleted(events);

	const { calls } = (await (await fetch(`${MCP}/_calls`)).json()) as {
		calls: Array<{
			_meta: Record<string, unknown> | null;
			arguments: Record<string, unknown>;
		}>;
	};
	expect(calls).toHaveLength(1);
	expect(calls[0]?._meta?.["waniwani/sessionId"]).toBe(sessionId);
	expect(calls[0]?._meta?.["waniwani/source"]).toBe("website");
	expect(calls[0]?._meta?.["waniwani/turnCount"]).toBe(1);
	// The fixture tool declares sessionId, so the runtime supplies it rather
	// than leaving the model to invent one.
	expect(calls[0]?.arguments?.sessionId).toBe(sessionId);
}, 120_000);

onSelfHosted("(b) a republished prompt reaches the next turn", async () => {
	const token = credential();
	const { sessionId } = await startSession("hello", token);

	await control({
		instructions: "You are a REPUBLISHED fixture assistant. Always call echo.",
	});
	// The revalidation floor, then one turn to kick the background pass off.
	await Bun.sleep(61_000);
	await sendTurn(sessionId, "again", token);
	await Bun.sleep(2_000);

	await fetch(`${MODEL}/_seen`, { method: "DELETE" });
	const events = await sendTurn(sessionId, "once more", token);
	expectCompleted(events);

	const seen = await seenByModel();
	expect(seen.length).toBeGreaterThan(0);
	expect(seen[0]?.system).toContain("REPUBLISHED");
}, 240_000);

onSelfHosted("(c) a session answers again after the runtime restarts", async () => {
	const token = credential();
	const { sessionId } = await startSession("hello", token);

	await restartEve();

	const events = await sendTurn(sessionId, "still there?", token);
	expectCompleted(events);
}, 240_000);

onSelfHosted("(d) an outage keeps warm sessions answering and fails a cold one loudly", async () => {
	const token = credential();
	const { sessionId } = await startSession("hello", token);

	await control({ failing: true });
	const warm = await sendTurn(sessionId, "are you still up?", token);
	expectCompleted(warm);

	await restartEve();
	const cold = await startSession("anyone there?", credential());
	const failure = cold.events.at(-1);
	expect(failure?.type).toBe("session.failed");
	expect(JSON.stringify(failure?.data)).toContain(
		"No published configuration for this agent",
	);
	expect(JSON.stringify(failure?.data)).toContain("500");
	expect(
		cold.events.some((event) => event.type === "message.completed"),
	).toBe(false);

	await control({ failing: false });
}, 300_000);

onHosted("(h) a managed model reaches the gateway base URL with the gateway key", async () => {
	await fetch(`${MODEL}/_seen`, { method: "DELETE" });

	const started = await startSession("hello", credential());
	expectCompleted(started.events);

	const seen = await seenByModel();
	expect(seen.length).toBeGreaterThan(0);
	expect(seen[0]?.authorization).toBe("Bearer test");
}, 300_000);
