import { expect, spyOn, test } from "bun:test";
import { runTurn } from "../src/core.js";

function mockFetch(
	impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(impl, { preconnect: fetch.preconnect });
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timedOut = new Promise<T>((resolve) => {
		timer = setTimeout(() => resolve(onTimeout()), ms);
	});
	return Promise.race([promise, timedOut]).finally(() => clearTimeout(timer));
}

test("runTurn resolves once the runtime accepts a new turn, without waiting for the stream to open", async () => {
	let streamRequested = false;
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname.endsWith("/session")) {
				return Response.json({ sessionId: "session-new" });
			}
			streamRequested = true;
			return new Promise<Response>(() => {});
		},
	});
	try {
		const turn = await withTimeout(
			runTurn({ eveUrl: server.url.toString(), credential: "wwk_test", message: "hi" }),
			500,
			() => {
				throw new Error("runTurn did not resolve before the stream attached");
			},
		);
		expect(turn.sessionId).toBe("session-new");
		expect(streamRequested).toBe(false);
	} finally {
		server.stop(true);
	}
}, 2_000);

test("runTurn resolves once a continuation is accepted, before the stream attaches", async () => {
	let streamRequested = false;
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST") {
				return Response.json({ sessionId: "session", deliveryId: "b" });
			}
			streamRequested = true;
			return new Promise<Response>(() => {});
		},
	});
	try {
		const turn = await withTimeout(
			runTurn({
				eveUrl: server.url.toString(), credential: "wwk_test", sessionId: "session", message: "hi", cursor: 3,
			}),
			500,
			() => {
				throw new Error("runTurn did not resolve before the stream attached");
			},
		);
		expect(turn.sessionId).toBe("session");
		expect(streamRequested).toBe(false);
	} finally {
		server.stop(true);
	}
}, 2_000);

test("a stream-attach failure errors the chunks stream and attempts to cancel the accepted turn", async () => {
	let streamAttempts = 0;
	const cancels: unknown[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/cancel")) {
				cancels.push(await request.json());
				return Response.json({ ok: true });
			}
			if (request.method === "POST" && url.pathname.endsWith("/session")) {
				return Response.json({ sessionId: "session-broken" });
			}
			streamAttempts += 1;
			return new Response("nope", { status: 400 });
		},
	});
	try {
		const turn = await runTurn({ eveUrl: server.url.toString(), credential: "wwk_test", message: "hi" });
		const reader = turn.chunks.getReader();
		expect((await reader.read()).value).toEqual({ type: "start", messageId: expect.any(String) });
		await expect(reader.read()).rejects.toThrow();
		expect(streamAttempts).toBe(2);
		expect(cancels).toEqual([]);
	} finally {
		server.stop(true);
	}
}, 2_000);

test("an abort signal already fired before submission finishes still rejects runTurn with its reason", async () => {
	const abort = new AbortController();
	const reason = new Error("caller gone");
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
				abort.abort(reason);
				return Response.json({ sessionId: "session", deliveryId: "b" });
			}
			return new Response(
				JSON.stringify({ type: "turn.started", data: { turnId: "turn_y" }, meta: { deliveryIds: ["b"] } }) + "\n",
			);
		},
	});
	try {
		await expect(
			runTurn({
				eveUrl: server.url.toString(), credential: "wwk_test", sessionId: "session", message: "hi", cursor: 0, signal: abort.signal,
			}),
		).rejects.toBe(reason);
		expect(cancels).toEqual([{ turnId: "turn_y" }]);
	} finally {
		server.stop(true);
	}
}, 2_000);

test("cancelling chunks while attachment is still awaiting headers aborts the underlying request", async () => {
	let requestAborted = false;
	let release: ((response: Response) => void) | undefined;
	const held = new Promise<Response>((resolve) => {
		release = resolve;
	});
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (request.method === "POST") return Response.json({ sessionId: "session-held" });
			request.signal.addEventListener("abort", () => {
				requestAborted = true;
			});
			return held;
		},
	});
	try {
		const turn = await runTurn({ eveUrl: server.url.toString(), credential: "wwk_test", message: "hi" });
		const reader = turn.chunks.getReader();
		const pending = reader.read();
		await Bun.sleep(50);
		await reader.cancel("client gone");
		await Bun.sleep(20);
		expect(requestAborted).toBe(true);
		release?.(new Response("", { status: 200 }));
		await pending.catch(() => {});
	} finally {
		server.stop(true);
	}
}, 2_000);

test("a reader obtained despite an already-cancelled attachment is itself cancelled, not leaked", async () => {
	let bodyCancelled = false;
	const posts: unknown[] = [];
	const held = new Promise<void>((resolve) => setTimeout(resolve, 20));
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
		mockFetch(async (input) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
			if (url.pathname.endsWith("/session") === false && url.pathname.includes("/stream")) {
				await held;
				const body = new ReadableStream<Uint8Array>({
					cancel() {
						bodyCancelled = true;
					},
				});
				return new Response(body, { status: 200 });
			}
			posts.push({ method: "POST" });
			return Response.json({ sessionId: "session-race" });
		}),
	);
	try {
		const turn = await runTurn({ eveUrl: "http://eve.test", credential: "wwk_test", message: "hi" });
		const reader = turn.chunks.getReader();
		const pending = reader.read();
		await reader.cancel("client gone");
		await pending.catch(() => {});
		await held;
		await Bun.sleep(20);
		expect(bodyCancelled).toBe(true);
	} finally {
		fetchSpy.mockRestore();
	}
}, 2_000);
