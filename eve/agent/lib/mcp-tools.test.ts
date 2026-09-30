import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { SessionAuthContext } from "eve/context";

type Step = { kind: "app" | "tool"; at: number; body?: unknown };

let steps: Step[] = [];
let toolCalls: Record<string, unknown>[] = [];

mock.module("./mcp-catalog.js", () => ({
	listMcpTools: () => {
		throw new Error("not used here");
	},
	callMcpTool: async (input: Record<string, unknown>) => {
		steps.push({ kind: "tool", at: Date.now() });
		toolCalls.push(input);
		return { content: [{ type: "text", text: "12 EUR" }] };
	},
	textOf: () => "",
}));

const { default: mcpTools } = await import("../tools/mcp.js");
const { holdSnapshot, releaseSnapshot } = await import("./turn-snapshot.js");
const { report } = await import("./reporting.js");

const { privateKey } = generateKeyPairSync("ed25519");
const PRIVATE_PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const originalFetch = globalThis.fetch;
const ENV_KEYS = [
	"WANIWANI_API_URL",
	"WANIWANI_SERVICE_PRIVATE_KEY",
	"WANIWANI_REGION",
	"WANIWANI_APP_PUBLIC_KEY",
	"WANIWANI_API_KEY",
] as const;
const saved = new Map<string, string | undefined>();

let counter = 0;
let appGate: Promise<Response> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function principal(attributes: Record<string, string>): SessionAuthContext {
	return {
		attributes,
		authenticator: "jwt-ecdsa",
		principalId: "waniwani:agent:visitor_1",
		principalType: "service",
		subject: "visitor_1",
	};
}

const NATIVE = { purpose: "browser", transport: "eve-native", environmentId: "env_tools", sid: "x" };
const SERVER = { environmentId: "env_tools", sid: "x" };

function ctxWith(input: { initiator: Record<string, string>; current?: Record<string, string> }) {
	counter += 1;
	const initiator = principal(input.initiator);
	const current = input.current ? principal(input.current) : initiator;
	const sessionId = `sess_tools_${counter}_${Date.now()}`;
	holdSnapshot(sessionId, {
		config: {
			environmentId: "env_tools",
			configId: "cfg_1",
			instructions: "be helpful",
			model: { mode: "managed", modelId: "openai/gpt-5-mini" },
			mcpUrl: "http://mcp.test.invalid:3002/mcp",
			webSearch: null,
			channels: [],
		},
		tools: [
			{
				name: "get_price",
				description: "Price for a plan",
				inputSchema: { type: "object", properties: { plan: { type: "string" } } },
			},
		],
	});
	return { session: { id: sessionId, auth: { current, initiator } } };
}

function turnStarted(turnId: string) {
	return { type: "turn.started", meta: { id: `ts_${turnId}`, at: "2026-09-29T10:00:00.000Z" }, data: { sequence: 0, turnId } };
}

async function resolveTools(ctx: ReturnType<typeof ctxWith>, turnId: string): Promise<Record<string, unknown>> {
	const events: unknown = Reflect.get(mcpTools, "events");
	const handler: unknown = isRecord(events) ? events["turn.started"] : undefined;
	if (typeof handler !== "function") throw new Error("the MCP dynamic has no turn.started handler");
	const resolved: unknown = await Reflect.apply(handler, undefined, [turnStarted(turnId), ctx]);
	return isRecord(resolved) ? resolved : {};
}

async function runTool(tools: Record<string, unknown>, name: string, toolCtx: Record<string, unknown> = {}): Promise<unknown> {
	const tool = tools[name];
	const execute: unknown = isRecord(tool) ? tool.execute : undefined;
	if (typeof execute !== "function") throw new Error(`tool ${name} has no execute`);
	return await Reflect.apply(execute, tool, [{ plan: "gold" }, { abortSignal: new AbortController().signal, ...toolCtx }]);
}

function executingAs(input: { sessionId: string; initiator: Record<string, string>; current: Record<string, string> }) {
	return {
		callId: "call_1",
		toolName: "get_price",
		session: { id: input.sessionId, auth: { current: principal(input.current), initiator: principal(input.initiator) } },
	};
}

async function outcomeOf(promise: Promise<unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		return { ok: false, error };
	}
}

beforeEach(() => {
	for (const key of ENV_KEYS) saved.set(key, process.env[key]);
	process.env.WANIWANI_API_URL = "http://app.test";
	process.env.WANIWANI_SERVICE_PRIVATE_KEY = PRIVATE_PEM;
	process.env.WANIWANI_REGION = "us";
	process.env.WANIWANI_APP_PUBLIC_KEY = "tools-test-app-key";
	delete process.env.WANIWANI_API_KEY;
	steps = [];
	toolCalls = [];
	appGate = undefined;
	globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			steps.push({ kind: "app", at: Date.now(), body });
			return await (appGate ?? Response.json({ ok: true }));
		},
		{ preconnect: originalFetch.preconnect },
	);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const key of ENV_KEYS) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("MCP tools for a turn", () => {
	test("a guardrail-blocked turn gets no tools", async () => {
		const ctx = ctxWith({ initiator: NATIVE, current: { ...NATIVE, guardrail: "blocked" } });
		const tools = await resolveTools(ctx, "turn_blocked");
		expect(Object.keys(tools)).toEqual([]);
		releaseSnapshot(ctx.session.id);
	});

	test("an unblocked turn gets the published tools", async () => {
		const ctx = ctxWith({ initiator: NATIVE });
		const tools = await resolveTools(ctx, "turn_open");
		expect(Object.keys(tools)).toEqual(["get_price"]);
		releaseSnapshot(ctx.session.id);
	});

	test("a native session's tool runs without asking the app about its turn's user row", async () => {
		appGate = new Promise<Response>(() => {});
		const ctx = ctxWith({ initiator: NATIVE });
		const tools = await resolveTools(ctx, "turn_b1");
		await runTool(tools, "get_price");
		expect(steps.map((step) => step.kind)).toEqual(["tool"]);
		releaseSnapshot(ctx.session.id);
	});

	test("a native session's tool does not wait for this process's own user-row delivery", async () => {
		appGate = new Promise<Response>(() => {});
		const ctx = ctxWith({ initiator: NATIVE });
		void report({ environmentId: "env_tools", sessionId: ctx.session.id }, [
			{ kind: "user_message", eventId: "eve_u", occurredAt: "2026-09-29T10:00:00.000Z", turnId: "turn_b2", text: "hi" },
		]);
		const tools = await resolveTools(ctx, "turn_b2");
		await runTool(tools, "get_price");
		expect(steps.map((step) => step.kind)).toEqual(["app", "tool"]);
		releaseSnapshot(ctx.session.id);
	});

	test("a native session's tool with a reserved user row asks the app nothing", async () => {
		const ctx = ctxWith({ initiator: NATIVE, current: { ...NATIVE, userEventId: "12" } });
		const tools = await resolveTools(ctx, "turn_b3");
		await runTool(tools, "get_price");
		expect(steps.map((step) => step.kind)).toEqual(["tool"]);
		releaseSnapshot(ctx.session.id);
	});

	test("a session a server token started runs its tool without asking the app", async () => {
		const ctx = ctxWith({ initiator: SERVER });
		const tools = await resolveTools(ctx, "turn_s");
		await runTool(tools, "get_price");
		expect(steps.map((step) => step.kind)).toEqual(["tool"]);
		releaseSnapshot(ctx.session.id);
	});

	test("a flagged message steered in after the tools resolved makes the tool throw without calling the MCP server", async () => {
		const ctx = ctxWith({ initiator: NATIVE });
		const tools = await resolveTools(ctx, "turn_steer");
		expect(Object.keys(tools)).toEqual(["get_price"]);
		const outcome = await outcomeOf(
			runTool(
				tools,
				"get_price",
				executingAs({ sessionId: ctx.session.id, initiator: NATIVE, current: { ...NATIVE, guardrail: "blocked" } }),
			),
		);
		expect(outcome.ok).toBe(false);
		expect(steps.filter((step) => step.kind === "tool")).toEqual([]);
		releaseSnapshot(ctx.session.id);
	});

	test("a steered block also stops a native session's tool", async () => {
		const ctx = ctxWith({ initiator: NATIVE });
		const tools = await resolveTools(ctx, "turn_steer_b");
		const outcome = await outcomeOf(
			runTool(
				tools,
				"get_price",
				executingAs({ sessionId: ctx.session.id, initiator: NATIVE, current: { ...NATIVE, guardrail: "blocked" } }),
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(outcome.ok).toBe(false);
		expect(steps.some((step) => step.kind === "tool")).toBe(false);
		releaseSnapshot(ctx.session.id);
	});

	test("a steered block on a session a server token started still stops the tool", async () => {
		const ctx = ctxWith({ initiator: SERVER });
		const tools = await resolveTools(ctx, "turn_steer_s");
		const outcome = await outcomeOf(
			runTool(
				tools,
				"get_price",
				executingAs({ sessionId: ctx.session.id, initiator: SERVER, current: { ...SERVER, guardrail: "blocked" } }),
			),
		);
		expect(outcome.ok).toBe(false);
		expect(steps.filter((step) => step.kind === "tool")).toEqual([]);
		releaseSnapshot(ctx.session.id);
	});

	test("the second call of a turn is stopped once a flagged message is steered in between", async () => {
		const ctx = ctxWith({ initiator: NATIVE });
		const tools = await resolveTools(ctx, "turn_two_calls");
		const clean = executingAs({ sessionId: ctx.session.id, initiator: NATIVE, current: NATIVE });
		const blocked = executingAs({
			sessionId: ctx.session.id,
			initiator: NATIVE,
			current: { ...NATIVE, guardrail: "blocked" },
		});
		expect((await outcomeOf(runTool(tools, "get_price", clean))).ok).toBe(true);
		expect((await outcomeOf(runTool(tools, "get_price", blocked))).ok).toBe(false);
		expect(steps.filter((step) => step.kind === "tool")).toHaveLength(1);
		releaseSnapshot(ctx.session.id);
	});

	test("a tool runs when the executing caller is clean even though an earlier message was blocked", async () => {
		const ctx = ctxWith({ initiator: NATIVE });
		const tools = await resolveTools(ctx, "turn_clean_now");
		const outcome = await outcomeOf(
			runTool(
				tools,
				"get_price",
				executingAs({ sessionId: ctx.session.id, initiator: { ...NATIVE, guardrail: "blocked" }, current: NATIVE }),
			),
		);
		expect(outcome.ok).toBe(true);
		expect(steps.filter((step) => step.kind === "tool")).toHaveLength(1);
		releaseSnapshot(ctx.session.id);
	});
});

const DOCUMENTS = [
	{ documentId: "0b6f3c1e-2a4d-4e8b-9c1f-3d5e7a9b1c2d", filename: "quote.pdf", mediaType: "application/pdf" },
	{ documentId: "1c7a4d2f-3b5e-4f9c-8d2a-4e6f8b0c2d3e", filename: "car.png", mediaType: "image/png" },
];

function metaOfLastCall(): Record<string, unknown> {
	const meta = toolCalls.at(-1)?.meta;
	return isRecord(meta) ? meta : {};
}

describe("MCP _meta for a browser turn", () => {
	test("the browser's documents reach waniwani/documents", async () => {
		const ctx = ctxWith({ initiator: NATIVE, current: { ...NATIVE, documents: JSON.stringify(DOCUMENTS) } });
		const tools = await resolveTools(ctx, "turn_docs");
		await runTool(tools, "get_price");
		expect(metaOfLastCall()["waniwani/documents"]).toEqual(DOCUMENTS);
		releaseSnapshot(ctx.session.id);
	});

	test("the browser's extra reaches waniwani/extra", async () => {
		const extra = { plan: "gold", utm: { source: "ads" } };
		const ctx = ctxWith({ initiator: NATIVE, current: { ...NATIVE, extra: JSON.stringify(extra) } });
		const tools = await resolveTools(ctx, "turn_extra");
		await runTool(tools, "get_price");
		expect(metaOfLastCall()["waniwani/extra"]).toEqual(extra);
		releaseSnapshot(ctx.session.id);
	});

	test("both reach _meta together, with the runtime's own keys intact", async () => {
		const extra = { plan: "gold" };
		const ctx = ctxWith({
			initiator: NATIVE,
			current: { ...NATIVE, documents: JSON.stringify(DOCUMENTS), extra: JSON.stringify(extra) },
		});
		const tools = await resolveTools(ctx, "turn_both");
		await runTool(tools, "get_price");
		const meta = metaOfLastCall();
		expect(meta["waniwani/documents"]).toEqual(DOCUMENTS);
		expect(meta["waniwani/extra"]).toEqual(extra);
		expect(meta["waniwani/sessionId"]).toBe(ctx.session.id);
		releaseSnapshot(ctx.session.id);
	});

	test("a turn with neither carries no documents or extra key", async () => {
		const ctx = ctxWith({ initiator: NATIVE });
		const tools = await resolveTools(ctx, "turn_none");
		await runTool(tools, "get_price");
		const meta = metaOfLastCall();
		expect("waniwani/documents" in meta).toBe(false);
		expect("waniwani/extra" in meta).toBe(false);
		releaseSnapshot(ctx.session.id);
	});

	test("the first message's documents do not ride along on a later turn", async () => {
		const ctx = ctxWith({ initiator: { ...NATIVE, documents: JSON.stringify(DOCUMENTS) }, current: NATIVE });
		const tools = await resolveTools(ctx, "turn_later");
		await runTool(tools, "get_price");
		expect("waniwani/documents" in metaOfLastCall()).toBe(false);
		releaseSnapshot(ctx.session.id);
	});
});
