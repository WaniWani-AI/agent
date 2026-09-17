import { describe, expect, test } from "bun:test";
import { withViewBinding } from "./view-binding.js";

const URI = "ui://views/ext-apps/quote.html?v=abc";
const RESULT = {
	content: [{ type: "text", text: "ok" }],
	structuredContent: { price: 42 },
	_meta: { "waniwani/sessionId": "wrun_1" },
};

describe("withViewBinding", () => {
	test("copies the definition's view binding onto a result that has none", () => {
		const out = withViewBinding(RESULT, {
			ui: { resourceUri: URI },
			"ui/resourceUri": URI,
		}) as { _meta: Record<string, unknown> };
		expect(out._meta).toEqual({
			"waniwani/sessionId": "wrun_1",
			ui: { resourceUri: URI },
			"ui/resourceUri": URI,
		});
	});

	test("the openai spelling travels too", () => {
		const out = withViewBinding({ content: [] }, {
			"openai/outputTemplate": URI,
		}) as { _meta: Record<string, unknown> };
		expect(out._meta).toEqual({ "openai/outputTemplate": URI });
	});

	test("a result that already binds a view is left alone", () => {
		const bound = { ...RESULT, _meta: { ui: { resourceUri: "ui://own.html" } } };
		expect(withViewBinding(bound, { ui: { resourceUri: URI } })).toBe(bound);
	});

	test("only the spellings the result lacks are filled in", () => {
		const bound = { ...RESULT, _meta: { "ui/resourceUri": "ui://own.html" } };
		const out = withViewBinding(bound, {
			ui: { resourceUri: URI },
			"ui/resourceUri": URI,
		}) as { _meta: Record<string, unknown> };
		expect(out._meta).toEqual({
			"ui/resourceUri": "ui://own.html",
			ui: { resourceUri: URI },
		});
	});

	test("a definition without a view changes nothing", () => {
		expect(withViewBinding(RESULT, { "some/other": 1 })).toBe(RESULT);
		expect(withViewBinding(RESULT, undefined)).toBe(RESULT);
	});

	test("a non-object result passes through", () => {
		expect(withViewBinding("text", { ui: { resourceUri: URI } })).toBe("text");
	});
});
