import { expect, test } from "bun:test";
import { encodeSse, runTurn } from "../src/core.js";
import type { EveEvent } from "../src/eve-client.js";

const event = (type: string, deliveryId?: string, data?: unknown): EveEvent => ({
	type, data, ...(deliveryId ? { meta: { deliveryIds: [deliveryId] } } : {}),
});
const text = (message: string, deliveryId: string, turnId = "turn_b") =>
	event("message.appended", deliveryId, { messageDelta: message, turnId });

type Recorded = {
	posts: unknown[];
	tailReads: number;
	streamStartIndexParams: (string | null)[];
};

/** A runtime whose tail is fixed at index 4 (so a tail read resumes at 5). */
function serve(events: EveEvent[], deliveryId = "b"): { url: string; recorded: Recorded; stop: () => void } {
	const recorded: Recorded = { posts: [], tailReads: 0, streamStartIndexParams: [] };
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST") {
				recorded.posts.push(await request.json());
				return Response.json({ sessionId: "session", deliveryId });
			}
			if (url.searchParams.has("includeTailIndex")) {
				recorded.tailReads += 1;
				return new Response("", { headers: { "x-eve-stream-tail-index": "4" } });
			}
			recorded.streamStartIndexParams.push(url.searchParams.get("startIndex"));
			return new Response(events.map((item) => JSON.stringify(item)).join("\n") + "\n");
		},
	});
	return { url: server.url.toString(), recorded, stop: () => server.stop(true) };
}

async function body(input: Parameters<typeof runTurn>[0]): Promise<string> {
	return new Response(encodeSse((await runTurn(input)).chunks)).text();
}

test("without a cursor, a continuation reads the tail before opening the stream at tail + 1", async () => {
	const { url, recorded, stop } = serve([text("HELLO", "b"), event("session.waiting", "b")]);
	try {
		const result = await body({ eveUrl: url, credential: "wwk_test", sessionId: "session", message: "hi" });
		expect(result).toContain("HELLO");
		expect(recorded.tailReads).toBe(1);
		expect(recorded.streamStartIndexParams).toEqual(["5"]);
	} finally {
		stop();
	}
});

test("with a cursor, a continuation skips the tail read entirely and opens at exactly that index", async () => {
	const { url, recorded, stop } = serve([text("HELLO", "b"), event("session.waiting", "b")]);
	try {
		const result = await body({
			eveUrl: url, credential: "wwk_test", sessionId: "session", message: "hi", cursor: 12,
		});
		expect(result).toContain("HELLO");
		expect(recorded.tailReads).toBe(0);
		expect(recorded.streamStartIndexParams).toEqual(["12"]);
	} finally {
		stop();
	}
});

test("cursor 0 is respected as a real position, not treated as absent", async () => {
	const { url, recorded, stop } = serve([text("HELLO", "b"), event("session.waiting", "b")]);
	try {
		const result = await body({
			eveUrl: url, credential: "wwk_test", sessionId: "session", message: "hi", cursor: 0,
		});
		expect(result).toContain("HELLO");
		expect(recorded.tailReads).toBe(0);
		// openEveStream omits the query param when the start index is 0.
		expect(recorded.streamStartIndexParams).toEqual([null]);
	} finally {
		stop();
	}
});

test("a cursor behind the tail still filters out other deliveries' events in between", async () => {
	const { url, recorded, stop } = serve([
		event("message.completed", "a", { message: "WRONG_A", turnId: "turn_a" }),
		event("session.waiting", "a"),
		event("turn.started", "b", { turnId: "turn_b" }),
		text("RIGHT_B", "b"),
		event("session.waiting", "a"),
		text("_END", "b"),
		event("session.waiting", "b"),
		text("WRONG_C", "c"),
	]);
	try {
		const result = await body({
			eveUrl: url, credential: "wwk_test", sessionId: "session", message: "follow-up", cursor: 0,
		});
		expect(result).toContain("RIGHT_B");
		expect(result).toContain("_END");
		expect(result).not.toContain("WRONG");
		expect(result).toContain('"finishReason":"stop"');
		expect(recorded.tailReads).toBe(0);
		expect(recorded.posts).toEqual([{ message: "follow-up", turnPolicy: "steer" }]);
	} finally {
		stop();
	}
});

test("cursor() reports the position consumed so far, counting events filtered out by delivery id", async () => {
	const { url, stop } = serve([
		event("session.waiting", "a"), // filtered out, still advances position
		text("B", "b"),
		event("session.waiting", "b"),
	]);
	try {
		const turn = await runTurn({
			eveUrl: url, credential: "wwk_test", sessionId: "session", message: "hi", cursor: 0,
		});
		await new Response(encodeSse(turn.chunks)).text();
		// 3 lines total were read off the stream (1 filtered + 2 kept) starting at 0.
		expect(turn.cursor()).toBe(3);
	} finally {
		stop();
	}
});

test("cursor() before any read of chunks reports the position the stream was opened at", async () => {
	const { url, stop } = serve([text("HELLO", "b"), event("session.waiting", "b")]);
	try {
		const turn = await runTurn({
			eveUrl: url, credential: "wwk_test", sessionId: "session", message: "hi", cursor: 9,
		});
		expect(turn.cursor()).toBe(9);
		await turn.chunks.cancel();
	} finally {
		stop();
	}
});
