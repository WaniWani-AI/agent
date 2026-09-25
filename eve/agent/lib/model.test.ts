import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveModelAccess } from "./model.js";
import type { SessionModel } from "./session-config.js";

const ENV_KEYS = ["AI_GATEWAY_BASE_URL", "AI_GATEWAY_API_KEY", "VERCEL", "MODEL_API_KEY"] as const;
let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof saved;
	for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function managed(
	overrides: Partial<Extract<SessionModel, { mode: "managed" }>> = {},
): SessionModel {
	return { mode: "managed", modelId: "openai/gpt-5", ...overrides };
}

function byo(overrides: Partial<Extract<SessionModel, { mode: "byo" }>> = {}): SessionModel {
	return {
		mode: "byo",
		provider: "openai",
		modelId: "gpt-4o",
		baseUrl: "https://byo.example/v1",
		...overrides,
	};
}

describe("a managed model without AI_GATEWAY_BASE_URL resolves to a gateway slug", () => {
	test("off Vercel it requires AI_GATEWAY_API_KEY", () => {
		expect(() => resolveModelAccess(managed())).toThrow("AI_GATEWAY_API_KEY is not set");
	});

	test("off Vercel with the key set resolves, carrying providerOptions and the context window", () => {
		process.env.AI_GATEWAY_API_KEY = "gw-key";
		const access = resolveModelAccess(
			managed({ providerOptions: { gateway: { order: ["a"] } }, contextWindowTokens: 8000 }),
		);
		expect(access).toEqual({
			kind: "gateway",
			modelId: "openai/gpt-5",
			providerOptions: { gateway: { order: ["a"] } },
			contextWindowTokens: 8000,
		});
	});

	test("on Vercel the key may be absent (OIDC)", () => {
		process.env.VERCEL = "1";
		expect(() => resolveModelAccess(managed())).not.toThrow();
		expect(resolveModelAccess(managed()).kind).toBe("gateway");
	});

	test("absent providerOptions and contextWindowTokens resolve to null, not undefined", () => {
		process.env.VERCEL = "1";
		const access = resolveModelAccess(managed());
		expect(access).toEqual({
			kind: "gateway",
			modelId: "openai/gpt-5",
			providerOptions: null,
			contextWindowTokens: null,
		});
	});

	test("an empty-string AI_GATEWAY_BASE_URL is treated as absent, not as an override", () => {
		process.env.AI_GATEWAY_BASE_URL = "";
		expect(() => resolveModelAccess(managed())).toThrow("AI_GATEWAY_API_KEY is not set");
	});
});

describe("AI_GATEWAY_BASE_URL switches a managed model to an openai-compatible endpoint", () => {
	test("carries providerOptions and the context window through", () => {
		process.env.AI_GATEWAY_BASE_URL = "https://gateway.internal/v1";
		process.env.AI_GATEWAY_API_KEY = "gw-key";
		const access = resolveModelAccess(
			managed({ providerOptions: { openai: { seed: 1 } }, contextWindowTokens: 4096 }),
		);
		expect(access).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://gateway.internal/v1",
			apiKey: "gw-key",
			modelId: "openai/gpt-5",
			providerOptions: { openai: { seed: 1 } },
			contextWindowTokens: 4096,
		});
	});

	test("still requires AI_GATEWAY_API_KEY even on Vercel", () => {
		process.env.AI_GATEWAY_BASE_URL = "https://gateway.internal/v1";
		process.env.VERCEL = "1";
		expect(() => resolveModelAccess(managed())).toThrow("AI_GATEWAY_API_KEY is not set");
	});
});

describe("a byo model", () => {
	test("uses its own api key over MODEL_API_KEY", () => {
		process.env.MODEL_API_KEY = "should-not-be-used";
		const access = resolveModelAccess(byo({ apiKey: "byo-key" }));
		expect(access).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://byo.example/v1",
			apiKey: "byo-key",
			modelId: "gpt-4o",
			providerOptions: null,
			contextWindowTokens: null,
		});
	});

	test("falls back to MODEL_API_KEY when the config carries no key", () => {
		process.env.MODEL_API_KEY = "fallback-key";
		const access = resolveModelAccess(byo());
		expect(access).toMatchObject({ apiKey: "fallback-key" });
	});

	test("throws when neither its own key nor MODEL_API_KEY is set", () => {
		expect(() => resolveModelAccess(byo())).toThrow("MODEL_API_KEY is not set");
	});

	test("never carries a context window from config, even if one were present on the type", () => {
		process.env.MODEL_API_KEY = "k";
		expect(resolveModelAccess(byo()).contextWindowTokens).toBeNull();
	});

	test("passes providerOptions through when present, null when absent", () => {
		process.env.MODEL_API_KEY = "k";
		expect(
			resolveModelAccess(byo({ providerOptions: { openai: { seed: 1 } } })).providerOptions,
		).toEqual({ openai: { seed: 1 } });
		expect(resolveModelAccess(byo()).providerOptions).toBeNull();
	});

	test("AI_GATEWAY_BASE_URL and VERCEL are irrelevant to a byo model", () => {
		process.env.AI_GATEWAY_BASE_URL = "https://gateway.internal/v1";
		process.env.VERCEL = "1";
		process.env.MODEL_API_KEY = "k";
		const access = resolveModelAccess(byo());
		expect(access).toEqual({
			kind: "openai-compatible",
			baseUrl: "https://byo.example/v1",
			apiKey: "k",
			modelId: "gpt-4o",
			providerOptions: null,
			contextWindowTokens: null,
		});
	});
});
