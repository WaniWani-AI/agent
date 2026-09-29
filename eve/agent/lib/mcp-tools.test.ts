import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { SessionAuthContext } from "eve/context";

type Step = { kind: "barrier" | "report" | "tool"; at: number; body?: unknown };

let steps: Step[] = [];

mock.module("./mcp-catalog.js", () => ({
	listMcpTools: () => {
		throw new Error("not used here");
	},
	callMcpTool: async () => {
		steps.push({ kind: "tool", at: Date.now() });
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
	"WANIWANI_AGENT_SECRET",
	"WANIWANI_API_KEY",
] as const;
const saved = new Map<string, string | undefined>();

let counter = 0;
let barrierGate: Promise<Response> | undefined;
let reportGate: Promise<Response> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function principal(attributes: Record<string, string>): SessionAuthContext {
	return {
		attributes,
		authenticator: "jwt-hmac",
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

async function runTool(tools: Record<string, unknown>, name: string): Promise<unknown> {
	const tool = tools[name];
	const execute: unknown = isRecord(tool) ? tool.execute : undefined;
	if (typeof execute !== "function") throw new Error(`tool ${name} has no execute`);
	return await Reflect.apply(execute, tool, [{ plan: "gold" }, { abortSignal: new AbortController().signal }]);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

beforeEach(() => {
	for (const key of ENV_KEYS) saved.set(key, process.env[key]);
	process.env.WANIWANI_API_URL = "http://app.test";
	process.env.WANIWANI_SERVICE_PRIVATE_KEY = PRIVATE_PEM;
	process.env.WANIWANI_REGION = "us";
	process.env.WANIWANI_AGENT_SECRET = "tools-test-secret";
	delete process.env.WANIWANI_API_KEY;
	steps = [];
	barrierGate = undefined;
	reportGate = undefined;
	globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			if (isRecord(body) && body.barrier !== undefined) {
				steps.push({ kind: "barrier", at: Date.now(), body });
				return await (barrierGate ?? Response.json({ data: { stored: true } }));
			}
			steps.push({ kind: "report", at: Date.now(), body });
			return await (reportGate ?? Response.json({ ok: true }));
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

	test("a native session's tool waits for the app to confirm the turn's user row", async () => {
		const gate = deferred<Response>();
		barrierGate = gate.promise;
		const ctx = ctxWith({ initiator: NATIVE });
		const tools = await resolveTools(ctx, "turn_b1");
		const running = runTool(tools, "get_price");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(steps.map((step) => step.kind)).toEqual(["barrier"]);
		const barrier = steps[0]?.body;
		expect(isRecord(barrier) && barrier.sessionId).toBe(ctx.session.id);
		expect(isRecord(barrier) && barrier.barrier).toEqual({ turnId: "turn_b1" });
		gate.resolve(Response.json({ data: { stored: true } }));
		await running;
		expect(steps.map((step) => step.kind)).toEqual(["barrier", "tool"]);
		releaseSnapshot(ctx.session.id);
	});

	test("a native session's tool waits for this process's own user-row delivery", async () => {
		const gate = deferred<Response>();
		reportGate = gate.promise;
		const ctx = ctxWith({ initiator: NATIVE });
		void report({ environmentId: "env_tools", sessionId: ctx.session.id }, [
			{ kind: "user_message", eventId: "eve_u", occurredAt: "2026-09-29T10:00:00.000Z", turnId: "turn_b2", text: "hi" },
		]);
		const tools = await resolveTools(ctx, "turn_b2");
		const running = runTool(tools, "get_price");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(steps.map((step) => step.kind)).toEqual(["report"]);
		gate.resolve(Response.json({ ok: true }));
		await running;
		expect(steps.map((step) => step.kind)).toEqual(["report", "tool"]);
		releaseSnapshot(ctx.session.id);
	});

	test("a session a server token started runs its tool with no barrier", async () => {
		const ctx = ctxWith({ initiator: SERVER });
		const tools = await resolveTools(ctx, "turn_s");
		await runTool(tools, "get_price");
		expect(steps.map((step) => step.kind)).toEqual(["tool"]);
		releaseSnapshot(ctx.session.id);
	});
});
