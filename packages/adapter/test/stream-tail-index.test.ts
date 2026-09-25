import { afterEach, expect, spyOn, test } from "bun:test";
import { EveError, continueEveSession } from "../src/eve-client.js";

const TARGET = { eveUrl: "http://eve.test", credential: "wwk_test" };
const SESSION_ID = "session-1";

function urlOf(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function isTailRead(input: RequestInfo | URL): boolean {
	return new URL(urlOf(input)).searchParams.has("includeTailIndex");
}

function postedBody(init: RequestInit | undefined): unknown {
	return typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
}

/** Bun's `fetch` also carries a `preconnect` static, which a mock must still satisfy. */
function mockFetch(
	impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
	return Object.assign(impl, { preconnect: fetch.preconnect });
}

let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
	fetchSpy?.mockRestore();
	fetchSpy = undefined;
});

test("a follow-up still posts and resolves when the tail read's body never ends and its cancel() never settles", async () => {
	const posts: unknown[] = [];
	// Stands in for Next.js's patched fetch: a body that never closes, whose
	// cancel() waits on a consumer that will never arrive.
	const stalled = new ReadableStream<Uint8Array>({ pull() {} });
	stalled.cancel = () => new Promise(() => {});

	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch(async (input, init) => {
		if (isTailRead(input)) {
			return new Response(stalled, { status: 200, headers: { "x-eve-stream-tail-index": "4" } });
		}
		posts.push(postedBody(init));
		return Response.json({ deliveryId: "delivery-1" });
	}));

	const outcome = await Promise.race([
		continueEveSession(TARGET, SESSION_ID, { message: "follow-up" }),
		new Promise((resolve) => setTimeout(() => resolve("timed out"), 500)),
	]);

	expect(outcome).toEqual({ startIndex: 5, deliveryId: "delivery-1" });
	expect(posts).toEqual([{ message: "follow-up", turnPolicy: "steer" }]);
});

test("the tail read's request is aborted once the header is read", async () => {
	let tailSignal: AbortSignal | undefined;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch(async (input, init) => {
		if (isTailRead(input)) {
			tailSignal = init?.signal ?? undefined;
			return new Response(null, { status: 200, headers: { "x-eve-stream-tail-index": "7" } });
		}
		return Response.json({ deliveryId: "delivery-2" });
	}));

	await continueEveSession(TARGET, SESSION_ID, { message: "follow-up" });

	expect(tailSignal).toBeDefined();
	expect(tailSignal?.aborted).toBe(true);
});

test("a non-ok tail read surfaces as an EveError carrying its status and body, and still aborts its request", async () => {
	const posts: unknown[] = [];
	let tailSignal: AbortSignal | undefined;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch(async (input, init) => {
		if (isTailRead(input)) {
			tailSignal = init?.signal ?? undefined;
			return new Response('{"error":"unknown session"}', { status: 404 });
		}
		posts.push(postedBody(init));
		return Response.json({ deliveryId: "delivery-3" });
	}));

	const error: unknown = await continueEveSession(
		TARGET, SESSION_ID, { message: "follow-up" },
	).catch((caught) => caught);

	if (!(error instanceof EveError)) throw error;
	expect(error.status).toBe(404);
	expect(error.message).toBe('{"error":"unknown session"}');
	expect(posts).toEqual([]);
	expect(tailSignal?.aborted).toBe(true);
});
