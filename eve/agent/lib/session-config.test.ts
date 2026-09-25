import { afterEach, beforeEach, expect, test } from "bun:test";
import { fetchSessionConfig } from "./session-config.js";
import { SELF_TENANT } from "./tenant.js";

let savedApiUrl: string | undefined;
let savedApiKey: string | undefined;

beforeEach(() => {
	savedApiUrl = process.env.WANIWANI_API_URL;
	savedApiKey = process.env.WANIWANI_API_KEY;
	process.env.WANIWANI_API_KEY = "wwk_test";
});

afterEach(() => {
	if (savedApiUrl === undefined) delete process.env.WANIWANI_API_URL;
	else process.env.WANIWANI_API_URL = savedApiUrl;
	if (savedApiKey === undefined) delete process.env.WANIWANI_API_KEY;
	else process.env.WANIWANI_API_KEY = savedApiKey;
});

function configPayload(model: unknown): Record<string, unknown> {
	return {
		environmentId: "env_1",
		configId: "cfg_1",
		instructions: "be helpful",
		mcpUrl: "https://mcp.example/mcp",
		model,
	};
}

async function withConfig(
	model: unknown,
	run: (config: Awaited<ReturnType<typeof fetchSessionConfig>>) => void,
): Promise<void> {
	const server = Bun.serve({
		port: 0,
		fetch() {
			return Response.json({ data: configPayload(model) });
		},
	});
	process.env.WANIWANI_API_URL = server.url.toString();
	try {
		run(await fetchSessionConfig({ tenant: { key: SELF_TENANT } }));
	} finally {
		server.stop(true);
	}
}

test("keeps providerOptions and contextWindowTokens for a managed model", async () => {
	await withConfig(
		{
			mode: "managed",
			modelId: "openai/gpt-5",
			providerOptions: { gateway: { order: ["a", "b"] } },
			contextWindowTokens: 128_000,
		},
		({ value }) => {
			expect(value.model).toEqual({
				mode: "managed",
				modelId: "openai/gpt-5",
				providerOptions: { gateway: { order: ["a", "b"] } },
				contextWindowTokens: 128_000,
			});
		},
	);
});

test("an older app that sends neither new field resolves both to null, not undefined", async () => {
	await withConfig({ mode: "managed", modelId: "openai/gpt-5" }, ({ value }) => {
		expect(value.model).toEqual({
			mode: "managed",
			modelId: "openai/gpt-5",
			providerOptions: null,
			contextWindowTokens: null,
		});
	});
});

test("an explicit null providerOptions stays null", async () => {
	await withConfig(
		{ mode: "managed", modelId: "m", providerOptions: null },
		({ value }) => {
			expect((value.model as { providerOptions: unknown }).providerOptions).toBeNull();
		},
	);
});

test("a zero context window is kept, not treated as absent", async () => {
	await withConfig(
		{ mode: "managed", modelId: "m", contextWindowTokens: 0 },
		({ value }) => {
			expect((value.model as { contextWindowTokens: unknown }).contextWindowTokens).toBe(0);
		},
	);
});

test("a non-numeric contextWindowTokens is treated as absent", async () => {
	await withConfig(
		{ mode: "managed", modelId: "m", contextWindowTokens: "128000" },
		({ value }) => {
			expect(
				(value.model as { contextWindowTokens: unknown }).contextWindowTokens,
			).toBeNull();
		},
	);
});

test("a byo model is unaffected by the new managed-only fields", async () => {
	await withConfig(
		{
			mode: "byo",
			provider: "openai",
			modelId: "gpt-4o",
			baseUrl: "https://byo.example/v1",
			providerOptions: { openai: { seed: 1 } },
		},
		({ value }) => {
			expect(value.model).toEqual({
				mode: "byo",
				provider: "openai",
				modelId: "gpt-4o",
				baseUrl: "https://byo.example/v1",
				providerOptions: { openai: { seed: 1 } },
			});
			expect("contextWindowTokens" in value.model).toBe(false);
		},
	);
});
