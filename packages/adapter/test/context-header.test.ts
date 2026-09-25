import { expect, test } from "bun:test";
import { encodeSse, runTurn } from "../src/core.js";
import type { UIMessageChunk } from "../src/ui-stream.js";

/** A stream that closes the turn immediately, so the test needs no real agent. */
function completedStream(): string {
	return `${JSON.stringify({ type: "session.completed", data: {} })}\n`;
}

async function captureHeaders(input: {
	context?: Record<string, unknown>;
	extra?: Record<string, unknown>;
}): Promise<{ contextHeader: string | null; extraHeader: string | null }> {
	let contextHeader: string | null = null;
	let extraHeader: string | null = null;
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (request.method === "POST") {
				contextHeader = request.headers.get("x-waniwani-context");
				extraHeader = request.headers.get("x-waniwani-extra");
				return Response.json({ sessionId: "session-1" });
			}
			return new Response(completedStream());
		},
	});
	try {
		const turn = await runTurn({
			eveUrl: server.url.toString(),
			credential: "wwk_test",
			message: "hi",
			...input,
		});
		await turn.chunks.cancel();
	} finally {
		server.stop(true);
	}
	return { contextHeader, extraHeader };
}

test("omits both headers when neither context nor extra is given", async () => {
	const { contextHeader, extraHeader } = await captureHeaders({});
	expect(contextHeader).toBeNull();
	expect(extraHeader).toBeNull();
});

test("an explicit empty context object still sends a header", async () => {
	const { contextHeader } = await captureHeaders({ context: {} });
	expect(contextHeader).toBe("{}");
});

test("carries unicode filenames and emoji through the header and back exactly", async () => {
	const context = { "waniwani/documents": ["简历.pdf"], note: "🎉 café" };
	const extra = { visitorName: "山田太郎" };
	const { contextHeader, extraHeader } = await captureHeaders({ context, extra });

	expect(contextHeader).not.toBeNull();
	expect(extraHeader).not.toBeNull();
	// fetch() throws on any header value outside Latin-1; reaching this line already
	// proves both were sendable. The sender promises pure printable ASCII, so check that too.
	expect(/^[\x20-\x7e]*$/.test(contextHeader as string)).toBe(true);
	expect(/^[\x20-\x7e]*$/.test(extraHeader as string)).toBe(true);

	expect(JSON.parse(contextHeader as string)).toEqual(context);
	expect(JSON.parse(extraHeader as string)).toEqual(extra);
});

test("a lone astral character round-trips as one surrogate pair, not two mangled halves", async () => {
	const context = { face: "😀" };
	const { contextHeader } = await captureHeaders({ context });
	expect(JSON.parse(contextHeader as string)).toEqual(context);
});

test("embedded quotes and backslashes survive the header round trip", async () => {
	const context = { note: 'she said "ok" \\ then left' };
	const { contextHeader } = await captureHeaders({ context });
	expect(JSON.parse(contextHeader as string)).toEqual(context);
});

function chunkStream(values: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
	return new ReadableStream({
		start(controller) {
			for (const value of values) controller.enqueue(value);
			controller.close();
		},
	});
}

test("an AI SDK data part flows through encodeSse unchanged", async () => {
	const frames = (
		await new Response(
			encodeSse(
				chunkStream([
					{ type: "start" },
					{ type: "data-weather", data: { temp: 72 }, id: "d1", transient: true },
					{ type: "finish", finishReason: "stop" },
				]),
			),
		).text()
	)
		.split("\n\n")
		.filter(Boolean);

	expect(frames[1]).toBe(
		'data: {"type":"data-weather","data":{"temp":72},"id":"d1","transient":true}',
	);
});
