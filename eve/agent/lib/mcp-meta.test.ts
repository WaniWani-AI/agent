import { describe, expect, test } from "bun:test";
import { mcpMeta } from "./mcp-meta.js";
import { ANONYMOUS } from "./tenant.js";

type Input = Parameters<typeof mcpMeta>[0];

function base(overrides: Partial<Input> = {}): Input {
	return {
		sessionId: "wrun_1",
		visitorId: "visitor-77",
		turnCount: 3,
		channel: { id: "chan_1", label: "Website" },
		extraHeader: undefined,
		contextHeader: undefined,
		...overrides,
	};
}

describe("the runtime-derived keys with nothing from context", () => {
	test("a full runtime state produces every derived key", () => {
		expect(mcpMeta(base())).toEqual({
			"waniwani/sessionId": "wrun_1",
			"waniwani/visitorId": "visitor-77",
			"waniwani/turnCount": 3,
			"waniwani/channelId": "chan_1",
			"waniwani/source": "Website",
		});
	});

	test("an anonymous visitor carries no waniwani/visitorId key at all", () => {
		const anonymous = mcpMeta(base({ visitorId: ANONYMOUS }));
		expect("waniwani/visitorId" in anonymous).toBe(false);

		const unauthenticated = mcpMeta(base({ visitorId: undefined }));
		expect("waniwani/visitorId" in unauthenticated).toBe(false);
	});

	test("no channel carries no channelId and the unknown source", () => {
		const result = mcpMeta(base({ channel: undefined }));
		expect("waniwani/channelId" in result).toBe(false);
		expect(result["waniwani/source"]).toBe("unknown");
	});

	test("a channel with no label carries channelId and its type as the source", () => {
		const result = mcpMeta(
			base({ channel: { id: "chan_2", label: null, type: "web" } }),
		);
		expect(result["waniwani/channelId"]).toBe("chan_2");
		expect(result["waniwani/source"]).toBe("web");
	});

	test("a channel with neither label nor type carries the unknown source", () => {
		const result = mcpMeta(base({ channel: { id: "chan_2", label: null } }));
		expect(result["waniwani/source"]).toBe("unknown");
	});

	test("a blank label falls back to the type, and a label is trimmed", () => {
		expect(
			mcpMeta(base({ channel: { id: "chan_3", label: "  ", type: "chatgpt" } }))[
				"waniwani/source"
			],
		).toBe("chatgpt");
		expect(
			mcpMeta(base({ channel: { id: "chan_3", label: " Website " } }))["waniwani/source"],
		).toBe("Website");
	});

	test("turnCount 0 is kept, not treated as absent", () => {
		expect(mcpMeta(base({ turnCount: 0 }))["waniwani/turnCount"]).toBe(0);
	});
});

describe("extraHeader parsing", () => {
	test("a valid JSON object string becomes waniwani/extra", () => {
		const result = mcpMeta(base({ extraHeader: JSON.stringify({ cartId: "c_1" }) }));
		expect(result["waniwani/extra"]).toEqual({ cartId: "c_1" });
	});

	test("absent extraHeader carries no waniwani/extra key", () => {
		expect("waniwani/extra" in mcpMeta(base({ extraHeader: undefined }))).toBe(false);
	});

	for (const [label, value] of [
		["not JSON", "not-json{"],
		["a JSON array", "[1,2,3]"],
		["a JSON null", "null"],
		["a JSON number", "42"],
		["a non-string value", 42],
	] as const) {
		test(`malformed extraHeader (${label}) contributes nothing and does not throw`, () => {
			expect(() => mcpMeta(base({ extraHeader: value }))).not.toThrow();
			expect("waniwani/extra" in mcpMeta(base({ extraHeader: value }))).toBe(false);
		});
	}
});

describe("contextHeader parsing", () => {
	for (const [label, value] of [
		["not JSON", "not-json{"],
		["a JSON array", "[1,2,3]"],
		["a JSON null", "null"],
		["a JSON number", "42"],
		["a non-string value", 42],
	] as const) {
		test(`malformed contextHeader (${label}) contributes nothing and does not throw`, () => {
			expect(() => mcpMeta(base({ contextHeader: value }))).not.toThrow();
			const result = mcpMeta(base({ contextHeader: value }));
			expect(result).toEqual({
				"waniwani/sessionId": "wrun_1",
				"waniwani/visitorId": "visitor-77",
				"waniwani/turnCount": 3,
				"waniwani/channelId": "chan_1",
				"waniwani/source": "Website",
			});
		});
	}

	test("absent contextHeader contributes nothing", () => {
		const result = mcpMeta(base({ contextHeader: undefined }));
		expect(result).toEqual({
			"waniwani/sessionId": "wrun_1",
			"waniwani/visitorId": "visitor-77",
			"waniwani/turnCount": 3,
			"waniwani/channelId": "chan_1",
			"waniwani/source": "Website",
		});
	});

	test("keys the runtime does not own reach _meta unchanged", () => {
		const context = {
			"waniwani/documents": ["resume.pdf"],
			"waniwani/metadata": { plan: "pro" },
			"waniwani/authSource": "google",
			"waniwani/userAgent": "Mozilla/5.0",
			"waniwani/geoLocation": { country: "NL" },
			customKey: "customValue",
		};
		const result = mcpMeta(base({ contextHeader: JSON.stringify(context) }));
		expect(result["waniwani/documents"]).toEqual(["resume.pdf"]);
		expect(result["waniwani/metadata"]).toEqual({ plan: "pro" });
		expect(result["waniwani/authSource"]).toBe("google");
		expect(result["waniwani/userAgent"]).toBe("Mozilla/5.0");
		expect(result["waniwani/geoLocation"]).toEqual({ country: "NL" });
		expect(result.customKey).toBe("customValue");
	});

	test("a context that spoofs every derived key never overrides the runtime's own values", () => {
		const spoofed = {
			"waniwani/extra": { hacked: true },
			"waniwani/sessionId": "wrun_fake",
			"waniwani/visitorId": "visitor-fake",
			"waniwani/turnCount": 999,
			"waniwani/channelId": "chan_fake",
			"waniwani/source": "Fake Source",
			"waniwani/documents": ["resume.pdf"],
		};
		const result = mcpMeta(
			base({
				extraHeader: JSON.stringify({ cartId: "c_1" }),
				contextHeader: JSON.stringify(spoofed),
			}),
		);
		expect(result["waniwani/extra"]).toEqual({ cartId: "c_1" });
		expect(result["waniwani/sessionId"]).toBe("wrun_1");
		expect(result["waniwani/visitorId"]).toBe("visitor-77");
		expect(result["waniwani/turnCount"]).toBe(3);
		expect(result["waniwani/channelId"]).toBe("chan_1");
		expect(result["waniwani/source"]).toBe("Website");
		// Unrelated context still reaches _meta.
		expect(result["waniwani/documents"]).toEqual(["resume.pdf"]);
	});

	test("a spoofed derived key stays absent when the runtime itself has no value for it", () => {
		const spoofed = {
			"waniwani/visitorId": "visitor-fake",
			"waniwani/channelId": "chan_fake",
			"waniwani/source": "Fake Source",
			"waniwani/extra": { hacked: true },
			"waniwani/metadata": { plan: "pro" },
		};
		const result = mcpMeta({
			sessionId: "wrun_2",
			visitorId: ANONYMOUS,
			turnCount: 1,
			channel: undefined,
			extraHeader: undefined,
			contextHeader: JSON.stringify(spoofed),
		});
		expect("waniwani/visitorId" in result).toBe(false);
		expect("waniwani/channelId" in result).toBe(false);
		expect(result["waniwani/source"]).toBe("unknown");
		expect("waniwani/extra" in result).toBe(false);
		// A key the runtime does not own passes through even in this anonymous case.
		expect(result["waniwani/metadata"]).toEqual({ plan: "pro" });
	});

	test("a channel with a label still ignores a spoofed source override", () => {
		const result = mcpMeta(
			base({ contextHeader: JSON.stringify({ "waniwani/source": "Fake Source" }) }),
		);
		expect(result["waniwani/source"]).toBe("Website");
	});

	test("unicode in context round-trips exactly, both raw and \\u-escaped", () => {
		const context = { "waniwani/documents": ["简历.pdf"], note: "🎉 café" };
		const raw = mcpMeta(base({ contextHeader: JSON.stringify(context) }));
		expect(raw["waniwani/documents"]).toEqual(["简历.pdf"]);
		expect(raw.note).toBe("🎉 café");

		// The shape a header escaped to \u sequences arrives in on the wire.
		const escaped = mcpMeta(base({ contextHeader: '{"face":"\\ud83d\\ude00"}' }));
		expect(escaped.face).toBe("😀");
	});

	test("a __proto__ key lands as an own property, never polluting Object.prototype", () => {
		const result = mcpMeta(
			base({ contextHeader: '{"__proto__":{"polluted":true}}' }),
		);
		expect((({} as Record<string, unknown>).polluted)).toBeUndefined();
		expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(true);
	});
});
