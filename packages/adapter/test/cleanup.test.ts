import { expect, spyOn, test } from "bun:test";
import { cancelTurn, runTurn } from "../src/core.js";
import { openEveStream } from "../src/eve-client.js";

for (const stall of ["headers", "error body"] as const) {
	test(`attachment cleanup is bounded when cancellation stalls at ${stall}`, async () => {
		const abort = new AbortController();
		const originalError = new Error("browser disconnected during submission");
		const deadlines: number[] = [];
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const timer = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			deadlines.push(ms);
			return timeout(100);
		});
		const cancels: unknown[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname.endsWith("/cancel")) {
					cancels.push(await request.json());
					if (stall === "headers") return new Promise<Response>(() => {});
					return new Response(new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode("unfinished error"));
						},
					}), { status: 500 });
				}
				if (request.method === "POST") {
					abort.abort(originalError);
					return Response.json({ sessionId: "session" });
				}
				return new Response(JSON.stringify({
					type: "turn.started", data: { turnId: "turn_a" },
				}) + "\n");
			},
		});
		try {
			const result = runTurn({
				eveUrl: server.url.toString(), credential: "key", message: "A", signal: abort.signal,
			});
			await expect(result).rejects.toBe(originalError);
			expect(cancels).toEqual([{ turnId: "turn_a" }]);
			// Discovery and the POST share a single budget instead of restarting it.
			expect(deadlines).toEqual([10_000]);
		} finally {
			timer.mockRestore();
			server.stop(true);
		}
	}, 2_000);
}

for (const stall of ["headers", "error body"] as const) {
	test(`standalone cancellation is bounded when the runtime stalls at ${stall}`, async () => {
		const deadlines: number[] = [];
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const timer = spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
			deadlines.push(ms);
			return timeout(100);
		});
		const server = Bun.serve({
			port: 0,
			fetch() {
				if (stall === "headers") return new Promise<Response>(() => {});
				return new Response(new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("unfinished error"));
					},
				}), { status: 500 });
			},
		});
		try {
			await expect(cancelTurn({
				eveUrl: server.url.toString(), credential: "key", sessionId: "session",
			})).rejects.toThrow();
			expect(deadlines).toEqual([10_000]);
		} finally {
			timer.mockRestore();
			server.stop(true);
		}
	}, 2_000);
}

test("stream retry backoff stops when cleanup is aborted", async () => {
	const abort = new AbortController();
	const reason = new Error("cleanup deadline");
	let requested!: () => void;
	const firstRequest = new Promise<void>((resolve) => { requested = resolve; });
	const server = Bun.serve({
		port: 0,
		fetch() {
			requested();
			return new Response("not ready", { status: 503 });
		},
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const opened = openEveStream({
			target: { eveUrl: server.url.toString(), credential: "key" },
			sessionId: "session", startIndex: 0, signal: abort.signal,
		});
		await firstRequest;
		// Allow the response to enter its 250 ms backoff before aborting it.
		await Bun.sleep(20);
		abort.abort(reason);
		const outcome = await Promise.race([
			opened.catch((error) => error),
			new Promise((resolve) => { timeout = setTimeout(() => resolve("backoff ignored abort"), 100); }),
		]);
		expect(outcome).toBe(reason);
	} finally {
		clearTimeout(timeout);
		server.stop(true);
	}
});
