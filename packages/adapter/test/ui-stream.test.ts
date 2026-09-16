import { expect, test } from "bun:test";
import type { EveEvent } from "../src/eve-client.js";
import { type UIMessageChunk, uiMessageChunks } from "../src/ui-stream.js";

/** One recorded turn off the CI stack: two steps, an `echo` call, one answer. */
const TRANSCRIPT = new URL("fixtures/turn.ndjson", import.meta.url);

function stream(events: EveEvent[]): ReadableStream<EveEvent> {
	return new ReadableStream({
		start(controller) {
			for (const event of events) controller.enqueue(event);
			controller.close();
		},
	});
}

async function translate(events: EveEvent[]): Promise<UIMessageChunk[]> {
	const chunks: UIMessageChunk[] = [];
	const reader = stream(events).pipeThrough(uiMessageChunks()).getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	return chunks;
}

async function recorded(): Promise<EveEvent[]> {
	const lines = (await Bun.file(TRANSCRIPT).text()).split("\n");
	return lines
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EveEvent);
}

test("translates a recorded turn into the embed's chunk sequence", async () => {
	const chunks = await translate(await recorded());

	expect(chunks.map((chunk) => chunk.type)).toEqual([
		"start",
		"start-step",
		"tool-input-available",
		"tool-output-available",
		"finish-step",
		"message-metadata",
		"start-step",
		"text-start",
		"text-delta",
		"text-end",
		"finish-step",
		"message-metadata",
		"finish",
	]);

	const text = chunks.filter((chunk) => chunk.type === "text-delta");
	expect(text).toHaveLength(1);
	expect(text[0]).toMatchObject({ delta: "the fixture answered" });
	expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
});

test("announces the tool call once and hands the result through unchanged", async () => {
	const chunks = await translate(await recorded());

	const call = chunks.find((chunk) => chunk.type === "tool-input-available");
	expect(call).toMatchObject({
		toolCallId: "call_1",
		toolName: "echo",
		input: { text: "hello" },
		dynamic: true,
	});

	const result = chunks.find((chunk) => chunk.type === "tool-output-available");
	expect(result).toMatchObject({ toolCallId: "call_1", dynamic: true });
	expect(
		(result as { output: { content: Array<{ text: string }> } }).output.content[0]?.text,
	).toBe("echo: hello");
});

test("trails each step with its model and usage", async () => {
	const trailers = (await translate(await recorded()))
		.filter(
			(chunk): chunk is Extract<UIMessageChunk, { type: "message-metadata" }> =>
				chunk.type === "message-metadata",
		)
		.map((chunk) => chunk.messageMetadata["waniwani/step"]);

	expect(trailers).toHaveLength(2);
	expect(trailers).toEqual([
		{
			stepIndex: 0,
			modelId: "openai/fixture/model",
			usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0 },
		},
		{
			stepIndex: 1,
			modelId: "openai/fixture/model",
			usage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 0 },
		},
	]);
});

test("a failed tool call becomes an error chunk, never a result", async () => {
	const chunks = await translate([
		{ type: "step.started", data: { modelId: "m", stepIndex: 0 } },
		{
			type: "actions.requested",
			data: {
				actions: [
					{ callId: "call_9", input: { text: "boom" }, kind: "tool-call", toolName: "echo" },
				],
			},
		},
		{
			type: "action.result",
			data: {
				result: { callId: "call_9", kind: "tool-result", output: "boom", isError: true },
				status: "failed",
				error: { code: "ACTION_RESULT_FAILED", message: "the tool exploded" },
			},
		},
		{ type: "step.completed", data: { stepIndex: 0 } },
	]);

	expect(chunks.some((chunk) => chunk.type === "tool-output-available")).toBe(false);
	expect(chunks.find((chunk) => chunk.type === "tool-output-error")).toEqual({
		type: "tool-output-error",
		toolCallId: "call_9",
		errorText: "the tool exploded",
		dynamic: true,
	});
});

test("a failed turn ends the message as an error", async () => {
	const chunks = await translate([
		{ type: "step.started", data: { modelId: "m", stepIndex: 0 } },
		{ type: "turn.failed", data: { message: "No published configuration for this agent" } },
	]);

	expect(chunks.find((chunk) => chunk.type === "error")).toEqual({
		type: "error",
		errorText: "No published configuration for this agent",
	});
	expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "error" });
});
