import { describe, expect, test } from "bun:test";
import { wrapLanguageModel } from "ai";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4FunctionTool,
	LanguageModelV4ProviderTool,
} from "@ai-sdk/provider";
import webSearchTool from "../tools/web_search.js";
import { webSearchScope } from "./web-search.js";

type Tool = LanguageModelV4FunctionTool | LanguageModelV4ProviderTool;
type Scope = Parameters<typeof webSearchScope>[0];

function recordingModel(seen: LanguageModelV4CallOptions[]): LanguageModelV4 {
	return {
		specificationVersion: "v4",
		provider: "gateway",
		modelId: "openai/gpt-5-mini",
		supportedUrls: {},
		doGenerate: async (options) => {
			seen.push(options);
			return {
				content: [{ type: "text", text: "ok" }],
				finishReason: { unified: "stop", raw: "stop" },
				usage: {
					inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
					outputTokens: { total: 1, text: 1, reasoning: 0 },
				},
				warnings: [],
			};
		},
		doStream: async (options) => {
			seen.push(options);
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.close();
					},
				}),
			};
		},
	};
}

async function toolsSeen(scope: Scope, tools: Tool[] | undefined, via: "generate" | "stream" = "generate") {
	const seen: LanguageModelV4CallOptions[] = [];
	const model = wrapLanguageModel({ model: recordingModel(seen), middleware: webSearchScope(scope) });
	const options: LanguageModelV4CallOptions = { prompt: [], ...(tools ? { tools } : {}) };
	if (via === "generate") await model.doGenerate(options);
	else await model.doStream(options);
	expect(seen).toHaveLength(1);
	return seen[0]?.tools;
}

const EXA: LanguageModelV4ProviderTool = {
	type: "provider",
	id: "gateway.exa_search",
	name: "web_search",
	args: { numResults: 5 },
};

const PERPLEXITY: LanguageModelV4ProviderTool = {
	type: "provider",
	id: "gateway.perplexity_search",
	name: "web_search",
	args: {},
};

const OPENAI_SEARCH: LanguageModelV4ProviderTool = {
	type: "provider",
	id: "openai.web_search",
	name: "web_search",
	args: {},
};

const OTHER_PROVIDER: LanguageModelV4ProviderTool = {
	type: "provider",
	id: "openai.code_interpreter",
	name: "code_interpreter",
	args: {},
};

const FUNCTION_NAMED_WEB_SEARCH: LanguageModelV4FunctionTool = {
	type: "function",
	name: "web_search",
	description: "the customer's own search",
	inputSchema: { type: "object", properties: { q: { type: "string" } } },
};

const GET_PRICE: LanguageModelV4FunctionTool = {
	type: "function",
	name: "get_price",
	description: "price",
	inputSchema: { type: "object", properties: {} },
};

describe("web search off", () => {
	test("the provider web_search tool is removed", async () => {
		expect(await toolsSeen(null, [EXA, GET_PRICE])).toEqual([GET_PRICE]);
	});

	test("every provider tool named web_search is removed, whatever its id", async () => {
		expect(await toolsSeen(null, [EXA, PERPLEXITY, OPENAI_SEARCH])).toEqual([]);
	});

	test("a function tool named web_search is kept", async () => {
		expect(await toolsSeen(null, [EXA, FUNCTION_NAMED_WEB_SEARCH])).toEqual([FUNCTION_NAMED_WEB_SEARCH]);
	});

	test("other provider tools are kept", async () => {
		expect(await toolsSeen(null, [OTHER_PROVIDER, EXA])).toEqual([OTHER_PROVIDER]);
	});

	test("a streamed call is scoped the same way", async () => {
		expect(await toolsSeen(null, [EXA, GET_PRICE], "stream")).toEqual([GET_PRICE]);
	});

	test("a call with no tools stays without tools", async () => {
		const tools = await toolsSeen(null, undefined);
		expect(tools === undefined || (Array.isArray(tools) && tools.length === 0)).toBe(true);
	});
});

describe("web search on with no domain filters", () => {
	const unfiltered: Array<[string, Scope]> = [
		["null filters", { includeDomains: null, excludeDomains: null }],
		["empty filters", { includeDomains: [], excludeDomains: [] }],
		["one empty, one null", { includeDomains: [], excludeDomains: null }],
	];
	for (const [label, scope] of unfiltered) {
		test(`${label} keep every tool unchanged`, async () => {
			const tools = [EXA, PERPLEXITY, FUNCTION_NAMED_WEB_SEARCH, GET_PRICE];
			expect(await toolsSeen(scope, tools)).toEqual(tools);
		});
	}
});

describe("web search on with domain filters", () => {
	test("includeDomains is merged into the Exa search's args", async () => {
		const tools = await toolsSeen({ includeDomains: ["example.com"], excludeDomains: null }, [EXA]);
		expect(tools).toEqual([{ ...EXA, args: { numResults: 5, includeDomains: ["example.com"] } }]);
	});

	test("excludeDomains is merged into the Exa search's args", async () => {
		const tools = await toolsSeen({ includeDomains: null, excludeDomains: ["spam.test"] }, [EXA]);
		expect(tools).toEqual([{ ...EXA, args: { numResults: 5, excludeDomains: ["spam.test"] } }]);
	});

	test("both filters are merged together", async () => {
		const tools = await toolsSeen({ includeDomains: ["a.com", "b.com"], excludeDomains: ["c.com"] }, [EXA]);
		expect(tools).toEqual([
			{ ...EXA, args: { numResults: 5, includeDomains: ["a.com", "b.com"], excludeDomains: ["c.com"] } },
		]);
	});

	test("an empty list next to a real one adds only the real one", async () => {
		const tools = await toolsSeen({ includeDomains: ["a.com"], excludeDomains: [] }, [EXA]);
		expect(tools).toEqual([{ ...EXA, args: { numResults: 5, includeDomains: ["a.com"] } }]);
	});

	test("a web_search provider tool with another id is removed", async () => {
		const tools = await toolsSeen({ includeDomains: ["a.com"], excludeDomains: null }, [PERPLEXITY, OPENAI_SEARCH, EXA]);
		expect(tools).toEqual([{ ...EXA, args: { numResults: 5, includeDomains: ["a.com"] } }]);
	});

	test("function tools, even one named web_search, are left alone", async () => {
		const tools = await toolsSeen({ includeDomains: ["a.com"], excludeDomains: ["b.com"] }, [
			FUNCTION_NAMED_WEB_SEARCH,
			GET_PRICE,
		]);
		expect(tools).toEqual([FUNCTION_NAMED_WEB_SEARCH, GET_PRICE]);
	});

	test("other provider tools are left alone", async () => {
		const tools = await toolsSeen({ includeDomains: ["a.com"], excludeDomains: null }, [OTHER_PROVIDER]);
		expect(tools).toEqual([OTHER_PROVIDER]);
	});

	test("the caller's tool objects are not mutated", async () => {
		const exa: LanguageModelV4ProviderTool = { ...EXA, args: { numResults: 5 } };
		await toolsSeen({ includeDomains: ["a.com"], excludeDomains: null }, [exa]);
		expect(exa.args).toEqual({ numResults: 5 });
	});

	test("one scope applies the same way to every call it wraps", async () => {
		const seen: LanguageModelV4CallOptions[] = [];
		const model = wrapLanguageModel({
			model: recordingModel(seen),
			middleware: webSearchScope({ includeDomains: ["a.com"], excludeDomains: null }),
		});
		await model.doGenerate({ prompt: [], tools: [EXA] });
		await model.doGenerate({ prompt: [], tools: [EXA] });
		expect(seen.map((options) => options.tools)).toEqual([
			[{ ...EXA, args: { numResults: 5, includeDomains: ["a.com"] } }],
			[{ ...EXA, args: { numResults: 5, includeDomains: ["a.com"] } }],
		]);
	});
});

describe("the compiled web_search tool", () => {
	test("is eve's provider-managed web search", async () => {
		const eve = await import("eve/tools/web_search");
		expect(webSearchTool).toBe(eve.default);
	});
});
