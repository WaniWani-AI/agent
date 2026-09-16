import express from "express";

const PORT = Number(process.env.PORT || 3003);

type Seen = { authorization: string | null; system: string; tools: string[] };
type Body = {
	model?: string;
	messages?: Array<{ role: string; content: unknown }>;
	tools?: Array<{ function?: { name?: string } }>;
};

const seen: Seen[] = [];
const state = { delayMs: 0 };

const ECHO = { name: "echo", arguments: '{"text":"hello"}' };
const ECHO_CALL = {
	tool_calls: [{ index: 0, type: "function", id: "call_1", function: ECHO }],
};

function frame(model: string, choice: unknown): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-fixture",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, ...(choice as object) }],
	})}\n\n`;
}

const app = express();
app.use(express.json({ limit: "10mb" }));

app.post("/_control", (request, response) => {
	Object.assign(state, request.body);
	response.json(state);
});
app.get("/_seen", (_request, response) => response.json({ seen }));
app.delete("/_seen", (_request, response) => {
	seen.length = 0;
	response.status(204).end();
});

app.post("/v1/chat/completions", async (request, response) => {
	if (state.delayMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, state.delayMs));
	}
	const body = request.body as Body;
	const messages = body.messages ?? [];
	const model = body.model ?? "fixture/model";

	seen.push({
		authorization: request.headers.authorization ?? null,
		system: messages
			.filter((message) => message.role === "system")
			.map((message) => String(message.content))
			.join("\n"),
		tools: (body.tools ?? []).flatMap((tool) =>
			tool.function?.name ? [tool.function.name] : [],
		),
	});
	response.set({ "content-type": "text/event-stream", "cache-control": "no-cache" });
	response.flushHeaders();
	response.write(frame(model, { delta: { role: "assistant", content: "" } }));

	// A turn calls `echo` first, then answers off its result.
	const answering = messages.some((message) => message.role === "tool");
	const delta = answering ? { content: "the fixture answered" } : ECHO_CALL;
	response.write(frame(model, { delta }));
	response.write(
		frame(model, { delta: {}, finish_reason: answering ? "stop" : "tool_calls" }),
	);
	response.end("data: [DONE]\n\n");
});

app.listen(PORT, () => console.log(`[fixture model] listening on ${PORT}`));
