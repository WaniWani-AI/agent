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

/** The adapter's router, mounted inside the MCP fixture as the template mounts it. */
const AGENT = `${MCP}/agent/v1`;
const PUBLIC_KEY = process.env.WANIWANI_PUBLIC_KEY ?? "wwp_test";
const ORIGIN = process.env.WANIWANI_ALLOWED_ORIGINS ?? "http://localhost:5173";
const WIDGET_URI = "ui://views/ext-apps/echo.html";

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

/**
 * eve authorizes no session-addressed route, so a hosted token names the one it
 * may touch. The self-hosted key is not a per-visitor token and carries nothing.
 */
function bindTo(token: string, sessionId: string): string {
	return HOSTED ? credential({ sid: sessionId }) : token;
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
		{ headers: { authorization: `Bearer ${bindTo(token, sessionId)}` } },
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
	headers: Record<string, string> = {},
): Promise<{ sessionId: string; events: StreamEvent[] }> {
	const response = await fetch(`${EVE}/eve/v1/session`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...headers,
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
	const bound = bindTo(token, sessionId);
	const before = await fetch(
		`${EVE}/eve/v1/session/${sessionId}/stream?startIndex=0&includeTailIndex=1`,
		{ headers: { authorization: `Bearer ${bound}` } },
	);
	const tail = Number(before.headers.get("x-eve-stream-tail-index") ?? 0);
	await before.body?.cancel().catch(() => {});

	// eve answers 409 `session_not_active` until the previous turn has parked.
	let delay = 250;
	for (let attempt = 0; ; attempt += 1) {
		const response = await fetch(`${EVE}/eve/v1/session/${sessionId}`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${bound}`,
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

type ModelRequest = {
	authorization: string | null;
	system: string;
	tools: string[];
	answering: boolean;
	finishedAt: number | null;
};

async function seenByModel(): Promise<ModelRequest[]> {
	const response = await fetch(`${MODEL}/_seen`);
	return ((await response.json()) as { seen: ModelRequest[] }).seen;
}

async function modelControl(patch: Record<string, unknown>): Promise<void> {
	const response = await fetch(`${MODEL}/_control`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch),
	});
	expect(response.ok).toBe(true);
}

/** A fresh process, and with it a fresh rate-limit window. */
async function restartMcp(): Promise<void> {
	const proc = Bun.spawn([
		"docker",
		"compose",
		"-f",
		"compose.ci.yaml",
		"--env-file",
		ENV_FILE,
		"restart",
		"mcp",
	]);
	expect(await proc.exited).toBe(0);
	for (let attempt = 0; attempt < 60; attempt += 1) {
		// `/_calls` sits outside the router, so polling it costs no request budget.
		const ready = await fetch(`${MCP}/_calls`).catch(() => null);
		if (ready?.ok) return;
		await Bun.sleep(500);
	}
	throw new Error("the MCP fixture did not come back");
}

function browserPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(AGENT, {
		method: "POST",
		headers: {
			authorization: `Bearer ${PUBLIC_KEY}`,
			"content-type": "application/json",
			origin: ORIGIN,
			...headers,
		},
		body: JSON.stringify(body),
	});
}

function userMessage(text: string): unknown {
	return { messages: [{ role: "user", parts: [{ type: "text", text }] }] };
}

/** The UI message stream the SDK's embed reads, one parsed chunk at a time. */
async function* uiChunks(response: Response): AsyncGenerator<Record<string, unknown>> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("the turn returned no body");
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const data = buffer.slice(0, boundary).trim().replace(/^data: /, "");
				buffer = buffer.slice(boundary + 2);
				if (data === "[DONE]") return;
				if (data) yield JSON.parse(data) as Record<string, unknown>;
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

const onSelfHosted = test.skipIf(HOSTED);
const onHosted = test.skipIf(!HOSTED);

beforeAll(async () => {
	await control({
		failing: false,
		model: HOSTED ? { mode: "managed", modelId: "openai/test" } : BYO_MODEL,
		instructions: "You are a fixture assistant. Always call the echo tool first.",
	});
	// Cold, so the first turn reads the state this run set.
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
			authorization: string | null;
		}>;
	};
	expect(calls).toHaveLength(1);
	expect(calls[0]?._meta?.["waniwani/sessionId"]).toBe(sessionId);
	expect(calls[0]?._meta?.["waniwani/source"]).toBe("website");
	expect(calls[0]?._meta?.["waniwani/turnCount"]).toBe(1);
	// The fixture tool declares sessionId, so the runtime supplies it rather
	// than leaving the model to invent one.
	expect(calls[0]?.arguments?.sessionId).toBe(sessionId);
	// A protected MCP server authenticates the environment key, the way the
	// app's own chat route forwards it.
	expect(calls[0]?.authorization).toBe("Bearer wwk_test");
}, 120_000);

onSelfHosted(
	"(a2) the visitor and context headers reach the MCP server",
	async () => {
		await fetch(`${MCP}/_calls`, { method: "DELETE" });
		const { sessionId } = await startSession("hello", credential(), {
			"x-waniwani-visitor": "visitor-42",
			"x-waniwani-extra": JSON.stringify({ plan: "pro" }),
		});

		const { calls } = (await (await fetch(`${MCP}/_calls`)).json()) as {
			calls: Array<{ _meta: Record<string, unknown> | null }>;
		};
		expect(calls[0]?._meta?.["waniwani/sessionId"]).toBe(sessionId);
		expect(calls[0]?._meta?.["waniwani/visitorId"]).toBe("visitor-42");
		expect(calls[0]?._meta?.["waniwani/extra"]).toEqual({ plan: "pro" });
	},
	120_000,
);

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

onSelfHosted("(e) the router streams a turn as the model writes it", async () => {
	await fetch(`${MODEL}/_seen`, { method: "DELETE" });
	// Holds the answering response open after its content delta, so the
	// assertion below catches the first chunk in flight.
	await modelControl({ tailDelayMs: 3_000 });

	try {
		const response = await browserPost(userMessage("hello"));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		expect(response.headers.get("x-session-id")).toMatch(/^wrun_/);

		const chunks: Array<Record<string, unknown>> = [];
		let modelStillWriting: boolean | undefined;
		for await (const chunk of uiChunks(response)) {
			chunks.push(chunk);
			if (chunk.type === "text-delta" && modelStillWriting === undefined) {
				modelStillWriting = (await seenByModel()).some(
					(seen) => seen.answering && seen.finishedAt === null,
				);
			}
		}

		expect(modelStillWriting).toBe(true);

		const text = chunks.filter((chunk) => chunk.type === "text-delta");
		expect(text.length).toBeGreaterThan(0);
		expect(text.map((chunk) => chunk.delta).join("")).toBe("the fixture answered");

		const output = chunks.find((chunk) => chunk.type === "tool-output-available") as
			| { toolCallId: string; output: { content: Array<{ text: string }> } }
			| undefined;
		expect(output?.toolCallId).toBe("call_1");
		expect(output?.output.content[0]?.text).toBe("echo: hello");
		expect(chunks.find((chunk) => chunk.type === "tool-input-available")).toMatchObject({
			toolName: "echo",
			input: { text: "hello" },
		});

		const steps = chunks.filter((chunk) => chunk.type === "message-metadata") as Array<{
			messageMetadata: { "waniwani/step": { modelId?: string; usage?: unknown } };
		}>;
		expect(steps).toHaveLength(2);
		for (const step of steps) {
			expect(step.messageMetadata["waniwani/step"].modelId).toBe("openai/fixture/model");
			expect(step.messageMetadata["waniwani/step"].usage).toMatchObject({
				inputTokens: 11,
				outputTokens: 7,
			});
		}

		expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });

		// Straight after, on the session that just parked, which is the window
		// where a follow-up can pick up the previous turn's boundary.
		await modelControl({ tailDelayMs: 0 });
		const again = await browserPost({
			sessionId: response.headers.get("x-session-id"),
			messages: [{ role: "user", parts: [{ type: "text", text: "and again" }] }],
		});
		expect(again.status).toBe(200);

		const answer: string[] = [];
		for await (const chunk of uiChunks(again)) {
			if (chunk.type === "text-delta") answer.push(String(chunk.delta));
		}
		expect(answer.join("")).toBe("the fixture answered");
	} finally {
		await modelControl({ tailDelayMs: 0 });
	}
}, 180_000);

onSelfHosted("(f) an iframe loads a widget, and a widget calls a tool", async () => {
	const response = await fetch(
		`${AGENT}/resource?uri=${encodeURIComponent(WIDGET_URI)}&token=${PUBLIC_KEY}`,
	);

	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/html");
	const html = await response.text();
	expect(html).toContain('<div id="echo"></div>');
	expect(html.toLowerCase()).toStartWith("<!doctype html>");

	await fetch(`${MCP}/_calls`, { method: "DELETE" });
	const called = await fetch(`${AGENT}/tool`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${PUBLIC_KEY}`,
			"content-type": "application/json",
			origin: ORIGIN,
			"x-session-id": "wrun_widget",
		},
		body: JSON.stringify({ name: "echo", arguments: { text: "from the widget" } }),
	});
	expect(called.status).toBe(200);

	const result = (await called.json()) as {
		content: Array<{ text: string }>;
		_meta: Record<string, Record<string, unknown>>;
	};
	expect(result.content[0]?.text).toBe("echo: from the widget");
	// The rendered widget learns where to report and what to present there.
	expect(result._meta["waniwani/widget"]).toMatchObject({
		sessionId: "wrun_widget",
		token: PUBLIC_KEY,
	});

	const { calls } = (await (await fetch(`${MCP}/_calls`)).json()) as {
		calls: Array<{
			authorization: string | null;
			arguments: Record<string, unknown>;
			_meta: Record<string, unknown> | null;
		}>;
	};
	// The router forwards the environment key, the way the runtime does, so a
	// server that authenticates it answers both callers.
	expect(calls[0]?.authorization).toBe("Bearer wwk_test");
	expect(calls[0]?.arguments.sessionId).toBe("wrun_widget");
	// And the conversation the call belongs to, which is what attributes it.
	expect(calls[0]?._meta?.["waniwani/sessionId"]).toBe("wrun_widget");

	// A widget posts from the origin this router served it on, and the event
	// reaches WaniWani under the public key.
	const reported = await fetch(`${AGENT}/events`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${PUBLIC_KEY}`,
			"content-type": "application/json",
			origin: new URL(AGENT).origin,
		},
		body: JSON.stringify({ events: [{ name: "widget.clicked" }] }),
	});
	expect(reported.status).toBe(200);

	const { events } = (await (await fetch(`${APP}/_events`)).json()) as {
		events: unknown[];
	};
	expect(JSON.stringify(events)).toContain("widget.clicked");
}, 60_000);

onSelfHosted("(g) the router refuses a missing key, a foreign origin and a flood", async () => {
	expect((await fetch(`${AGENT}/config`)).status).toBe(401);
	expect(
		(await browserPost(userMessage("hello"), { origin: "https://attacker.example" })).status,
	).toBe(403);

	await restartMcp();
	for (let request = 1; request <= 60; request += 1) {
		const response = await fetch(`${AGENT}/config`, {
			headers: { authorization: `Bearer ${PUBLIC_KEY}` },
		});
		expect(response.status).toBe(200);
	}
	const flooded = await fetch(`${AGENT}/config`, {
		headers: { authorization: `Bearer ${PUBLIC_KEY}` },
	});
	expect(flooded.status).toBe(429);
	expect(await flooded.json()).toEqual({ error: "rate_limited" });
}, 120_000);

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

onHosted(
	"(h2) a hosted token reaches only the session it names",
	async () => {
		const { sessionId } = await startSession("hello", credential());

		const unbound = await fetch(
			`${EVE}/eve/v1/session/${sessionId}/stream?startIndex=0`,
			{ headers: { authorization: `Bearer ${credential()}` } },
		);
		await unbound.body?.cancel().catch(() => {});
		expect(unbound.status).toBe(401);

		const elsewhere = await fetch(
			`${EVE}/eve/v1/session/${sessionId}/stream?startIndex=0`,
			{
				headers: {
					authorization: `Bearer ${credential({ sid: "wrun_somebody_else" })}`,
				},
			},
		);
		await elsewhere.body?.cancel().catch(() => {});
		expect(elsewhere.status).toBe(401);

		const bound = await fetch(
			`${EVE}/eve/v1/session/${sessionId}/stream?startIndex=0&includeTailIndex=1`,
			{ headers: { authorization: `Bearer ${credential({ sid: sessionId })}` } },
		);
		await bound.body?.cancel().catch(() => {});
		expect(bound.status).toBe(200);
	},
	120_000,
);
