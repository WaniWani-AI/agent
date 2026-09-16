import { expect, test } from "bun:test";
import { encodeSse, runTurn } from "../src/core.js";
import type { EveEvent } from "../src/eve-client.js";

const event = (type: string, deliveryId?: string, data?: unknown): EveEvent => ({
	type, data, ...(deliveryId ? { meta: { deliveryIds: [deliveryId] } } : {}),
});
const text = (message: string, deliveryId: string, turnId = "turn_b") =>
	event("message.appended", deliveryId, { messageDelta: message, turnId });

async function runtime(
	events: EveEvent[],
	check: (input: Parameters<typeof runTurn>[0], posts: unknown[], cancels: unknown[]) => Promise<void>,
	options: { deliveryId?: unknown; noNewline?: boolean } = { deliveryId: "b" },
) {
	const posts: unknown[] = [];
	const cancels: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/cancel")) {
				cancels.push(await request.json());
				return Response.json({ ok: true });
			}
			if (request.method === "POST") {
				posts.push(await request.json());
				return Response.json({ sessionId: "session", deliveryId: options.deliveryId });
			}
			if (url.searchParams.has("includeTailIndex")) {
				return new Response("", { headers: { "x-eve-stream-tail-index": "4" } });
			}
			expect(url.searchParams.get("startIndex")).toBe("5");
			return new Response(events.map((item) => JSON.stringify(item)).join("\n") + (options.noNewline ? "" : "\n"));
		},
	});
	try {
		await check({ eveUrl: server.url.toString(), credential: "wwk_test", sessionId: "session", message: "follow-up" }, posts, cancels);
	} finally {
		server.stop(true);
	}
}

async function response(input: Parameters<typeof runTurn>[0]) {
	return new Response(encodeSse((await runTurn(input)).chunks)).text();
}

test("follow-up ignores the previous answer and waiting event between tail read and POST", async () => {
	await runtime([
		event("message.completed", "a", { message: "WRONG_A", turnId: "turn_a" }),
		event("session.waiting", "a"),
		event("turn.started", "b", { turnId: "turn_b" }),
		text("RIGHT_B", "b"),
		event("session.waiting", "a"), // Another delivery cannot close B either.
		text("_END", "b"),
		event("session.waiting", "b"),
		text("WRONG_C", "c"),
	], async (input, posts) => {
		const body = await response(input);
		expect(body).toContain("RIGHT_B");
		expect(body).toContain("_END");
		expect(body).not.toContain("WRONG");
		expect(body).toContain('"finishReason":"stop"');
		expect(posts).toEqual([{ message: "follow-up", turnPolicy: "steer" }]);
	});
});

test("correlation works without a new turn.started marker and with batched delivery IDs", async () => {
	await runtime([
		event("session.waiting", "a"),
		{ ...text("B_AND_C", "b"), meta: { deliveryIds: ["b", "c"] } },
		{ type: "session.waiting", meta: { deliveryIds: ["b", "c"] } },
	], async (input) => {
		expect(await response(input)).toContain("B_AND_C");
	});
});

for (const deliveryId of [undefined, "", 42]) {
	test(`rejects an incompatible runtime delivery id (${deliveryId})`, async () => {
		await runtime([], async (input) => {
			await expect(runTurn(input)).rejects.toThrow("no delivery id");
		}, { deliveryId });
	});
}

for (const type of ["session.failed", "session.completed"]) {
	test(`${type} before the accepted delivery fails instead of completing or hanging`, async () => {
		await runtime([event(type, "a")], async (input) => {
			const body = await response(input);
			expect(body).toContain("before the accepted message");
			expect(body).toContain('"finishReason":"error"');
		});
	});
}

test("a session-wide failure after delivery starts is still reported", async () => {
	await runtime([text("partial", "b"), event("session.failed", undefined, { message: "runtime failed" })], async (input) => {
		const body = await response(input);
		expect(body).toContain("runtime failed");
		expect(body).toContain('"finishReason":"error"');
	});
});

test("EOF without a newline still requires the accepted delivery's boundary", async () => {
	await runtime([event("session.waiting", "a")], async (input) => {
		expect(await response(input)).toContain('"finishReason":"error"');
	}, { deliveryId: "b", noNewline: true });
	await runtime([text("B", "b"), event("session.waiting", "b")], async (input) => {
		expect(await response(input)).toContain('"finishReason":"stop"');
	}, { deliveryId: "b", noNewline: true });
});

test("response cancellation targets its delivery's turn, never the later current turn", async () => {
	await runtime([
		event("turn.started", "a", { turnId: "turn_a" }),
		event("session.waiting", "a"),
		event("turn.started", "b", { turnId: "turn_b" }),
		text("B", "b"),
		event("session.waiting", "b"),
		event("turn.started", "c", { turnId: "turn_c" }),
	], async (input, _posts, cancels) => {
		const turn = await runTurn(input);
		// No consumption required: cleanup can resolve ownership before the UI reads.
		await Promise.all([turn.cancel(), turn.cancel()]);
		expect(cancels).toEqual([{ turnId: "turn_b" }]);
		await turn.chunks.cancel();
	});
});

test("an abort during submission resolves ownership before cancelling", async () => {
	const abort = new AbortController();
	const cancels: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/cancel")) {
				cancels.push(await request.json());
				return Response.json({ ok: true });
			}
			if (request.method === "POST") {
				abort.abort();
				return Response.json({ sessionId: "session", deliveryId: "b" });
			}
			if (url.searchParams.has("includeTailIndex")) {
				return new Response("", { headers: { "x-eve-stream-tail-index": "4" } });
			}
			return new Response([
				event("session.waiting", "a"),
				event("turn.started", "b", { turnId: "turn_b" }),
			].map((item) => JSON.stringify(item)).join("\n") + "\n");
		},
	});
	try {
		await expect(runTurn({ eveUrl: server.url.toString(), credential: "key", sessionId: "session", message: "B", signal: abort.signal })).rejects.toThrow();
		expect(cancels).toEqual([{ turnId: "turn_b" }]);
	} finally {
		server.stop(true);
	}
});

test("closing an earlier delivery in a batched turn cannot cancel its latest delivery", async () => {
	const batched: EveEvent[] = [
		{ type: "turn.started", data: { turnId: "turn_bc" }, meta: { deliveryIds: ["b", "c"] } },
		{ type: "session.waiting", meta: { deliveryIds: ["b", "c"] } },
	];
	await runtime(batched, async (input, _posts, cancels) => {
		const turn = await runTurn(input);
		await turn.cancel();
		expect(cancels).toEqual([]);
		await turn.chunks.cancel();
	});
	await runtime(batched, async (input, _posts, cancels) => {
		const turn = await runTurn(input);
		await turn.cancel();
		expect(cancels).toEqual([{ turnId: "turn_bc" }]);
		await turn.chunks.cancel();
	}, { deliveryId: "c" });
});
