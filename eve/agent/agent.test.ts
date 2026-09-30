import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LanguageModelV4CallOptions, LanguageModelV4ProviderTool } from "@ai-sdk/provider";
import agent from "./agent.js";
import type { SessionConfig, SessionModel } from "./lib/session-config.js";
import { holdSnapshot, releaseSnapshot } from "./lib/turn-snapshot.js";

type Sent = { url: string; body: Record<string, unknown> };

const ENV_KEYS = ["AI_GATEWAY_API_KEY", "AI_GATEWAY_BASE_URL", "VERCEL", "MODEL_API_KEY"] as const;
const saved = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

const EXA: LanguageModelV4ProviderTool = { type: "provider", id: "gateway.exa_search", name: "web_search", args: {} };
const PERPLEXITY: LanguageModelV4ProviderTool = {
	type: "provider",
	id: "gateway.perplexity_search",
	name: "web_search",
	args: {},
};
const GET_PRICE = { type: "function" as const, name: "get_price", inputSchema: { type: "object" } };

const MANAGED: SessionModel = { mode: "managed", modelId: "openai/gpt-5-mini" };
const BYO: SessionModel = {
	mode: "byo",
	provider: "openai-compatible",
	modelId: "own-model",
	baseUrl: "http://own.test/v1",
	apiKey: "own-key",
};

let sent: Sent[] = [];
let counter = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chatCompletion(): Response {
	return Response.json({
		id: "chatcmpl_1",
		object: "chat.completion",
		created: 1,
		model: "own-model",
		choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	});
}

async function modelFor(input: { model: SessionModel; webSearch: SessionConfig["webSearch"] }) {
	counter += 1;
	const sessionId = `sess_agent_${counter}`;
	holdSnapshot(sessionId, {
		config: {
			environmentId: "env_agent",
			configId: "cfg_1",
			instructions: "be helpful",
			model: input.model,
			mcpUrl: "http://mcp.test.invalid/mcp",
			webSearch: input.webSearch,
			channels: [],
		},
		tools: [],
	});
	const dynamic: unknown = Reflect.get(agent, "model");
	const events: unknown = isRecord(dynamic) ? dynamic.events : undefined;
	const handler: unknown = isRecord(events) ? events["step.started"] : undefined;
	if (typeof handler !== "function") throw new Error("the agent's model has no step.started handler");
	const resolved: unknown = await Reflect.apply(handler, undefined, [
		{ type: "step.started", meta: { id: "s1", at: "2026-09-29T10:00:00.000Z" }, data: {} },
		{ session: { id: sessionId, auth: { current: null, initiator: null } } },
	]);
	releaseSnapshot(sessionId);
	const model: unknown = isRecord(resolved) ? resolved.model : undefined;
	const doGenerate: unknown = isRecord(model) ? model.doGenerate : undefined;
	if (typeof doGenerate !== "function") throw new Error("step.started resolved no language model");
	return async (options: LanguageModelV4CallOptions): Promise<unknown> =>
		await Reflect.apply(doGenerate, model, [options]);
}

function call(tools: LanguageModelV4CallOptions["tools"]): LanguageModelV4CallOptions {
	return { prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools };
}

function sentTools(): unknown[] {
	const tools = sent.at(-1)?.body.tools;
	return Array.isArray(tools) ? tools : [];
}

function warningsOf(result: unknown): unknown[] {
	const warnings = isRecord(result) ? result.warnings : undefined;
	return Array.isArray(warnings) ? warnings : [];
}

beforeEach(() => {
	for (const key of ENV_KEYS) saved.set(key, process.env[key]);
	process.env.AI_GATEWAY_API_KEY = "gw_test_key";
	delete process.env.AI_GATEWAY_BASE_URL;
	delete process.env.VERCEL;
	sent = [];
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			sent.push({ url, body: isRecord(body) ? body : {} });
			if (url.includes("ai-gateway")) return new Response("no", { status: 400 });
			return chatCompletion();
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

async function settled(promise: Promise<unknown>): Promise<unknown> {
	try {
		return await promise;
	} catch {
		return undefined;
	}
}

describe("web search on a Gateway model", () => {
	test("search off removes the web_search tool from the Gateway call", async () => {
		const generate = await modelFor({ model: MANAGED, webSearch: null });
		await settled(generate(call([EXA, GET_PRICE])));
		expect(sent.at(-1)?.url).toContain("ai-gateway");
		expect(sentTools()).toEqual([GET_PRICE]);
	});

	test("search on with no filters sends the web_search tool unchanged", async () => {
		const generate = await modelFor({ model: MANAGED, webSearch: { includeDomains: null, excludeDomains: null } });
		await settled(generate(call([EXA, GET_PRICE])));
		expect(sentTools()).toEqual([EXA, GET_PRICE]);
	});

	test("search on with filters sends the Exa search with them and drops other searches", async () => {
		const generate = await modelFor({
			model: MANAGED,
			webSearch: { includeDomains: ["docs.example.com"], excludeDomains: ["spam.test"] },
		});
		await settled(generate(call([PERPLEXITY, EXA])));
		expect(sentTools()).toEqual([
			{ ...EXA, args: { includeDomains: ["docs.example.com"], excludeDomains: ["spam.test"] } },
		]);
	});
});

describe("web search on an own model", () => {
	test("a BYO model never receives the web_search tool, even with search on", async () => {
		const generate = await modelFor({ model: BYO, webSearch: { includeDomains: null, excludeDomains: null } });
		const result = await generate(call([EXA, GET_PRICE]));
		expect(sent.at(-1)?.url).toBe("http://own.test/v1/chat/completions");
		expect(warningsOf(result)).toEqual([]);
	});

	test("a BYO model with domain filters never receives the web_search tool", async () => {
		const generate = await modelFor({ model: BYO, webSearch: { includeDomains: ["a.com"], excludeDomains: null } });
		const result = await generate(call([EXA]));
		expect(warningsOf(result)).toEqual([]);
	});

	test("a managed model behind an OpenAI-compatible Gateway URL never receives the web_search tool", async () => {
		process.env.AI_GATEWAY_BASE_URL = "http://gateway-compatible.test/v1";
		const generate = await modelFor({ model: MANAGED, webSearch: { includeDomains: null, excludeDomains: null } });
		const result = await generate(call([EXA]));
		expect(sent.at(-1)?.url).toBe("http://gateway-compatible.test/v1/chat/completions");
		expect(warningsOf(result)).toEqual([]);
	});

	test("the own-model probe is sensitive: a provider tool that reaches it leaves a warning", async () => {
		const { createOpenAI } = await import("@ai-sdk/openai");
		const result = await createOpenAI({ baseURL: "http://own.test/v1", apiKey: "k" }).chat("m").doGenerate(call([EXA]));
		expect(warningsOf(result).length).toBeGreaterThan(0);
	});
});
