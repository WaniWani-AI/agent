import { describe, expect, test } from "bun:test";
import { textOf, toolModelOutput } from "./tool-output.js";

describe("toolModelOutput", () => {
	test("text content reaches the model as text", () => {
		expect(
			toolModelOutput({ content: [{ type: "text", text: "echo: hello" }] }),
		).toEqual({ type: "text", value: "echo: hello" });
	});

	test("several text parts arrive joined", () => {
		expect(
			toolModelOutput({
				content: [
					{ type: "text", text: "one" },
					{ type: "text", text: "two" },
				],
			}),
		).toEqual({ type: "text", value: "one\ntwo" });
	});

	test("a structured-only result reaches the model as json", () => {
		expect(
			toolModelOutput({ content: [], structuredContent: { price: 42 } }),
		).toEqual({ type: "json", value: { price: 42 } });
	});

	test("text wins when a server sends both", () => {
		expect(
			toolModelOutput({
				content: [{ type: "text", text: "echo: hello" }],
				structuredContent: { price: 42 },
			}),
		).toEqual({ type: "text", value: "echo: hello" });
	});

	test("an empty result is an empty string rather than a crash", () => {
		expect(toolModelOutput({ content: [] })).toEqual({ type: "text", value: "" });
		expect(toolModelOutput({})).toEqual({ type: "text", value: "" });
	});

	test("_meta never reaches the model", () => {
		const output = toolModelOutput({
			content: [{ type: "text", text: "echo: hello" }],
			_meta: { "openai/outputTemplate": "ui://views/secret.html" },
		});
		expect(JSON.stringify(output)).not.toContain("outputTemplate");
	});

	test("non-text parts are skipped by textOf", () => {
		expect(
			textOf({ content: [{ type: "image", data: "…" }, { type: "text", text: "ok" }] }),
		).toBe("ok");
	});
});
