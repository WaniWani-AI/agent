import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { type ReportEvent, report, reserveUserRow } from "./reporting.js";

type Call = {
	url: URL;
	method: string;
	authorization: string | null;
	body: Record<string, unknown>;
	at: number;
	signal: AbortSignal | undefined;
};

const API_URL = "http://app.test";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIVATE_PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;
const ENV_KEYS = ["WANIWANI_API_URL", "WANIWANI_SERVICE_PRIVATE_KEY", "WANIWANI_REGION"] as const;
const saved = new Map<string, string | undefined>();

let calls: Call[] = [];
let sequence = 0;
let fakeClock = false;

function uniqueSession(): { environmentId: string; sessionId: string } {
	sequence += 1;
	return { environmentId: `env_${sequence}`, sessionId: `sess_${sequence}_${Date.now()}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stubFetch(answer: (call: Call, index: number) => Promise<Response> | Response): void {
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			const headers = new Headers(init?.headers);
			const parsed: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
			const call: Call = {
				url: new URL(raw),
				method: init?.method ?? "GET",
				authorization: headers.get("authorization"),
				body: isRecord(parsed) ? parsed : {},
				at: Date.now(),
				signal: init?.signal ?? undefined,
			};
			calls.push(call);
			return await answer(call, calls.length - 1);
		},
		{ preconnect: originalFetch.preconnect },
	);
}

function untilAborted(signal: AbortSignal | undefined): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		if (!signal) return;
		if (signal.aborted) reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

async function flush(): Promise<void> {
	for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
}

function useFakeClock(): number {
	jest.useFakeTimers();
	fakeClock = true;
	return Date.now();
}

async function runOut<T>(promise: Promise<T>): Promise<T> {
	let done = false;
	promise.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	for (let step = 0; step < 1_000 && !done; step += 1) {
		await flush();
		if (done) break;
		jest.advanceTimersToNextTimer();
	}
	if (!done) throw new Error("the report never settled");
	return await promise;
}

async function advance(ms: number): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		await flush();
		jest.advanceTimersByTime(Math.min(250, end - Date.now()));
	}
	await flush();
}

async function settle(ms = 50): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function userMessage(turnId: string, text = "hello", id?: number): ReportEvent {
	return {
		kind: "user_message",
		eventId: `eve_u_${turnId}`,
		occurredAt: "2026-09-29T10:00:00.000Z",
		turnId,
		text,
		...(id !== undefined ? { id } : {}),
	};
}

function assistantMessage(turnId: string, text = "hi!"): ReportEvent {
	return {
		kind: "assistant_message",
		eventId: `eve_a_${turnId}`,
		occurredAt: "2026-09-29T10:00:01.000Z",
		turnId,
		text,
	};
}

function eventIdsOf(call: Call | undefined): unknown[] {
	const events = call?.body.events;
	return Array.isArray(events) ? events.map((event) => (isRecord(event) ? event.eventId : undefined)) : [];
}

function gapsOf(list: Call[]): number[] {
	return list.slice(1).map((call, index) => call.at - (list[index]?.at ?? 0));
}

beforeEach(() => {
	for (const key of ENV_KEYS) saved.set(key, process.env[key]);
	process.env.WANIWANI_API_URL = API_URL;
	process.env.WANIWANI_SERVICE_PRIVATE_KEY = PRIVATE_PEM;
	process.env.WANIWANI_REGION = "us";
	calls = [];
	console.error = () => {};
});

afterEach(() => {
	if (fakeClock) {
		jest.useRealTimers();
		fakeClock = false;
	}
	globalThis.fetch = originalFetch;
	console.error = originalConsoleError;
	for (const key of ENV_KEYS) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("report: where and how", () => {
	test("posts the events to the app's events route for the session's environment", async () => {
		stubFetch(() => Response.json({ ok: true }));
		const session = uniqueSession();
		const events = [userMessage("turn_1")];
		expect(await report(session, events)).toBe(true);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.method).toBe("POST");
		expect(call?.url.origin).toBe(API_URL);
		expect(call?.url.pathname).toBe("/api/mcp/agent/events");
		expect(call?.url.searchParams.get("environmentId")).toBe(session.environmentId);
		expect(call?.body.sessionId).toBe(session.sessionId);
		expect(call?.body.events).toEqual(events);
	});

	test("a user_message carrying a reserved id sends that id", async () => {
		stubFetch(() => Response.json({ ok: true }));
		await report(uniqueSession(), [userMessage("turn_1", "hello", 4_242)]);
		const sent = calls[0]?.body.events;
		expect(Array.isArray(sent) && isRecord(sent[0]) ? sent[0].id : undefined).toBe(4_242);
	});

	test("the environment id is encoded into the query", async () => {
		stubFetch(() => Response.json({ ok: true }));
		const session = { environmentId: "env a&b=c/d", sessionId: `sess_enc_${Date.now()}` };
		await report(session, [userMessage("turn_1")]);
		expect(calls[0]?.url.searchParams.get("environmentId")).toBe("env a&b=c/d");
		expect([...(calls[0]?.url.searchParams.keys() ?? [])]).toEqual(["environmentId"]);
	});

	test("carries a service bearer the runtime's key signed for its region", async () => {
		stubFetch(() => Response.json({ ok: true }));
		await report(uniqueSession(), [userMessage("turn_1")]);
		const authorization = calls[0]?.authorization ?? "";
		expect(authorization.startsWith("Bearer ")).toBe(true);
		const [header, payload, signature] = authorization.slice("Bearer ".length).split(".");
		expect(header && payload && signature).toBeTruthy();
		const valid = verify(
			null,
			Buffer.from(`${header}.${payload}`),
			publicKey,
			Buffer.from(signature ?? "", "base64url"),
		);
		expect(valid).toBe(true);
		const claims: unknown = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
		expect(isRecord(claims) && claims.aud).toBe("waniwani:region:us");
	});

	test("report([]) sends nothing", async () => {
		stubFetch(() => Response.json({ ok: true }));
		await report(uniqueSession(), []);
		await settle();
		expect(calls).toHaveLength(0);
	});
});

function firstIds(): unknown[] {
	return calls.map((call) => eventIdsOf(call)[0]);
}

describe("report: order within one session", () => {
	test("a later report is not sent while an earlier one is in flight", async () => {
		const first = deferred<Response>();
		stubFetch((_call, index) => (index === 0 ? first.promise : Response.json({ ok: true })));
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		await settle(100);
		expect(firstIds()).toEqual(["eve_u_turn_1"]);
		first.resolve(Response.json({ ok: true }));
		expect(await a).toBe(true);
		expect(await b).toBe(true);
		expect(firstIds()).toEqual(["eve_u_turn_1", "eve_a_turn_1"]);
	});

	test("three reports land in the order they were made, each after the previous settled", async () => {
		const gates = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
		stubFetch((_call, index) => gates[index]?.promise ?? Response.json({ ok: true }));
		const session = uniqueSession();
		const all = Promise.all([
			report(session, [userMessage("t1")]),
			report(session, [assistantMessage("t1")]),
			report(session, [userMessage("t2")]),
		]);
		await settle(50);
		expect(calls).toHaveLength(1);
		gates[0]?.resolve(Response.json({ ok: true }));
		await settle(50);
		expect(calls).toHaveLength(2);
		gates[1]?.resolve(Response.json({ ok: true }));
		await settle(50);
		expect(calls).toHaveLength(3);
		gates[2]?.resolve(Response.json({ ok: true }));
		expect(await all).toEqual([true, true, true]);
		expect(firstIds()).toEqual(["eve_u_t1", "eve_a_t1", "eve_u_t2"]);
	});

	test("an earlier report's retries hold back the next one", async () => {
		useFakeClock();
		stubFetch((_call, index) => (index < 3 ? new Response("busy", { status: 503 }) : Response.json({ ok: true })));
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		expect(await runOut(a)).toBe(true);
		expect(await runOut(b)).toBe(true);
		expect(firstIds()).toEqual(["eve_u_turn_1", "eve_u_turn_1", "eve_u_turn_1", "eve_u_turn_1", "eve_a_turn_1"]);
	});

	test("an earlier report the app refuses does not stop the next one", async () => {
		stubFetch((call) =>
			eventIdsOf(call)[0] === "eve_u_turn_1" ? new Response("bad", { status: 400 }) : Response.json({ ok: true }),
		);
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		expect(await a).toBe(false);
		expect(await b).toBe(true);
		expect(firstIds()).toEqual(["eve_u_turn_1", "eve_a_turn_1"]);
	});

	test("an earlier report that gives up after its window does not stop the next one", async () => {
		useFakeClock();
		stubFetch((call) =>
			eventIdsOf(call)[0] === "eve_u_turn_1" ? new Response("down", { status: 503 }) : Response.json({ ok: true }),
		);
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		expect(await runOut(a)).toBe(false);
		const gaveUpAt = Date.now();
		expect(await runOut(b)).toBe(true);
		const ids = firstIds();
		expect(ids.at(-1)).toBe("eve_a_turn_1");
		expect(ids.filter((id) => id === "eve_a_turn_1")).toHaveLength(1);
		expect(ids.indexOf("eve_a_turn_1")).toBe(ids.length - 1);
		expect(calls.at(-1)?.at).toBeGreaterThanOrEqual(gaveUpAt);
	});

	test("an earlier report that throws on every attempt does not stop the next one", async () => {
		useFakeClock();
		stubFetch((call) => {
			if (eventIdsOf(call)[0] === "eve_u_turn_1") throw new TypeError("fetch failed");
			return Response.json({ ok: true });
		});
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		expect(await runOut(a)).toBe(false);
		expect(await runOut(b)).toBe(true);
		const ids = firstIds();
		expect(ids.lastIndexOf("eve_u_turn_1")).toBeLessThan(ids.indexOf("eve_a_turn_1"));
	});

	test("a queued report's 30 s window starts when its own delivery starts", async () => {
		const start = useFakeClock();
		stubFetch(() => new Response("down", { status: 503 }));
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		expect(await runOut(a)).toBe(false);
		expect(await runOut(b)).toBe(false);
		const later = calls.filter((call) => eventIdsOf(call)[0] === "eve_a_turn_1");
		const firstAt = later[0]?.at ?? start;
		expect(firstAt - start).toBeGreaterThanOrEqual(25_000);
		expect(gapsOf(later)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000]);
		expect(Date.now() - firstAt).toBeGreaterThanOrEqual(25_000);
		expect(Date.now() - firstAt).toBeLessThanOrEqual(30_000);
	});

	test("once a session's reports have settled, a new one goes out at once", async () => {
		stubFetch(() => Response.json({ ok: true }));
		const session = uniqueSession();
		expect(await report(session, [userMessage("turn_1")])).toBe(true);
		await settle(20);
		const gate = deferred<Response>();
		stubFetch(() => gate.promise);
		const next = report(session, [assistantMessage("turn_1")]);
		await settle(20);
		expect(firstIds()).toEqual(["eve_u_turn_1", "eve_a_turn_1"]);
		gate.resolve(Response.json({ ok: true }));
		expect(await next).toBe(true);
	});
});

describe("report: sessions do not wait on each other", () => {
	test("another session's report goes out while this session's is in flight", async () => {
		const first = deferred<Response>();
		stubFetch((_call, index) => (index === 0 ? first.promise : Response.json({ ok: true })));
		const one = uniqueSession();
		const two = uniqueSession();
		const a = report(one, [userMessage("turn_1")]);
		const b = report(two, [assistantMessage("turn_1")]);
		expect(await b).toBe(true);
		expect(calls.map((call) => call.body.sessionId)).toEqual([one.sessionId, two.sessionId]);
		first.resolve(Response.json({ ok: true }));
		expect(await a).toBe(true);
	});

	test("the same session id in another environment does not wait", async () => {
		const first = deferred<Response>();
		stubFetch((_call, index) => (index === 0 ? first.promise : Response.json({ ok: true })));
		const sessionId = `sess_shared_${Date.now()}`;
		const a = report({ environmentId: "env_x", sessionId }, [userMessage("turn_1")]);
		const b = report({ environmentId: "env_y", sessionId }, [assistantMessage("turn_1")]);
		expect(await b).toBe(true);
		expect(calls.map((call) => call.url.searchParams.get("environmentId"))).toEqual(["env_x", "env_y"]);
		first.resolve(Response.json({ ok: true }));
		expect(await a).toBe(true);
	});

	test("another session's report is not held back by this session's retries", async () => {
		useFakeClock();
		stubFetch((call) =>
			call.body.sessionId === "sess_retrying" ? new Response("down", { status: 503 }) : Response.json({ ok: true }),
		);
		const a = report({ environmentId: "env_r", sessionId: "sess_retrying" }, [userMessage("turn_1")]);
		const b = report({ environmentId: "env_r", sessionId: "sess_other" }, [assistantMessage("turn_1")]);
		await flush();
		expect(await b).toBe(true);
		expect(calls.filter((call) => call.body.sessionId === "sess_retrying")).toHaveLength(1);
		expect(await runOut(a)).toBe(false);
	});
});

describe("report: retries", () => {
	test("a network error is retried until it succeeds", async () => {
		useFakeClock();
		stubFetch((_call, index) => {
			if (index === 0) throw new TypeError("fetch failed");
			return Response.json({ ok: true });
		});
		expect(await runOut(report(uniqueSession(), [userMessage("t")]))).toBe(true);
		expect(calls).toHaveLength(2);
	});

	for (const status of [500, 502, 503, 504, 429]) {
		test(`a ${status} is retried until it succeeds`, async () => {
			useFakeClock();
			stubFetch((_call, index) => (index < 2 ? new Response("no", { status }) : Response.json({ ok: true })));
			expect(await runOut(report(uniqueSession(), [userMessage("t")]))).toBe(true);
			expect(calls).toHaveLength(3);
		});
	}

	test("the first wait is 250 ms and each wait doubles up to 5 s", async () => {
		useFakeClock();
		stubFetch(() => new Response("down", { status: 503 }));
		await runOut(report(uniqueSession(), [userMessage("t")]));
		expect(gapsOf(calls)).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000]);
	});

	test("a persistent 503 keeps trying for about 30 s, then reports failure and stops", async () => {
		const start = useFakeClock();
		stubFetch(() => new Response("down", { status: 503 }));
		const delivered = await runOut(report(uniqueSession(), [userMessage("t")]));
		const gaveUpAt = Date.now() - start;
		expect(delivered).toBe(false);
		expect(gaveUpAt).toBeLessThanOrEqual(30_000);
		expect(gaveUpAt).toBeGreaterThanOrEqual(25_000);
		for (const call of calls) expect(call.at - start).toBeLessThanOrEqual(30_000);
		const made = calls.length;
		await advance(60_000);
		expect(calls).toHaveLength(made);
	});

	test("a persistent network error keeps trying for about 30 s, then reports failure", async () => {
		const start = useFakeClock();
		stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		expect(await runOut(report(uniqueSession(), [userMessage("t")]))).toBe(false);
		expect(Date.now() - start).toBeLessThanOrEqual(30_000);
		expect(Date.now() - start).toBeGreaterThanOrEqual(25_000);
		expect(calls.length).toBeGreaterThan(4);
	});

	test("requests that hang until they time out still give up within 30 s", async () => {
		const start = useFakeClock();
		stubFetch((call) => untilAborted(call.signal));
		expect(await runOut(report(uniqueSession(), [userMessage("t")]))).toBe(false);
		expect(Date.now() - start).toBeLessThanOrEqual(30_000);
		expect(calls.length).toBeGreaterThan(1);
		for (const call of calls) expect(call.at - start).toBeLessThan(30_000);
	});

	test("a request that hangs until the window closes is cut off at 30 s", async () => {
		const start = useFakeClock();
		stubFetch((call, index) =>
			index === 0 ? new Response("down", { status: 503 }) : untilAborted(call.signal),
		);
		expect(await runOut(report(uniqueSession(), [userMessage("t")]))).toBe(false);
		expect(Date.now() - start).toBeLessThanOrEqual(30_000);
	});

	test("a delivery that lands late in the window still counts", async () => {
		const start = useFakeClock();
		stubFetch((call) => (call.at - start >= 20_000 ? Response.json({ ok: true }) : new Response("down", { status: 503 })));
		expect(await runOut(report(uniqueSession(), [userMessage("t")]))).toBe(true);
		const last = calls.at(-1);
		expect((last?.at ?? 0) - start).toBeGreaterThanOrEqual(20_000);
	});

	for (const status of [400, 401, 403, 404, 409, 422]) {
		test(`a ${status} is not retried`, async () => {
			useFakeClock();
			stubFetch(() => new Response("no", { status }));
			expect(await runOut(report(uniqueSession(), [userMessage("t")]))).toBe(false);
			await advance(35_000);
			expect(calls).toHaveLength(1);
		});
	}

	test("a 4xx after some 5xx retries stops at once", async () => {
		useFakeClock();
		stubFetch((_call, index) =>
			index < 2 ? new Response("down", { status: 503 }) : new Response("bad", { status: 400 }),
		);
		expect(await runOut(report(uniqueSession(), [userMessage("t")]))).toBe(false);
		await advance(35_000);
		expect(calls).toHaveLength(3);
	});

	test("every retry carries the same event ids", async () => {
		useFakeClock();
		stubFetch((_call, index) => (index < 2 ? new Response("oops", { status: 502 }) : Response.json({ ok: true })));
		await runOut(report(uniqueSession(), [userMessage("t"), assistantMessage("t")]));
		expect(calls.map(eventIdsOf)).toEqual([
			["eve_u_t", "eve_a_t"],
			["eve_u_t", "eve_a_t"],
			["eve_u_t", "eve_a_t"],
		]);
	});

	test("every retry carries the same body", async () => {
		useFakeClock();
		stubFetch((_call, index) => (index < 3 ? new Response("oops", { status: 500 }) : Response.json({ ok: true })));
		await runOut(report(uniqueSession(), [userMessage("t", "hello", 77)]));
		const first = JSON.stringify(calls[0]?.body);
		for (const call of calls) expect(JSON.stringify(call.body)).toBe(first);
	});
});

function answer(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("reserveUserRow", () => {
	test("asks the app's events route for the session's user row with the service bearer", async () => {
		stubFetch(() => answer({ data: { id: 42 } }));
		const session = uniqueSession();
		expect(await reserveUserRow(session)).toBe(42);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		expect(call?.method).toBe("POST");
		expect(call?.url.origin).toBe(API_URL);
		expect(call?.url.pathname).toBe("/api/mcp/agent/events");
		expect(call?.url.searchParams.get("environmentId")).toBe(session.environmentId);
		expect(call?.authorization?.startsWith("Bearer ")).toBe(true);
		expect(call?.body).toEqual({ sessionId: session.sessionId, reserve: true });
	});

	test("the largest safe integer is a usable id", async () => {
		stubFetch(() => answer({ data: { id: Number.MAX_SAFE_INTEGER } }));
		expect(await reserveUserRow(uniqueSession())).toBe(Number.MAX_SAFE_INTEGER);
	});

	test("1 is a usable id", async () => {
		stubFetch(() => answer({ data: { id: 1 } }));
		expect(await reserveUserRow(uniqueSession())).toBe(1);
	});

	const unusable: Array<[string, unknown]> = [
		["zero", { data: { id: 0 } }],
		["a negative id", { data: { id: -5 } }],
		["a fraction", { data: { id: 1.5 } }],
		["a numeric string", { data: { id: "42" } }],
		["an unsafe integer", { data: { id: 2 ** 53 } }],
		["null", { data: { id: null } }],
		["no id", { data: {} }],
		["data null", { data: null }],
		["id at the top level", { id: 42 }],
		["an array body", [42]],
	];
	for (const [label, body] of unusable) {
		test(`${label} is no id`, async () => {
			stubFetch(() => answer(body));
			expect(await reserveUserRow(uniqueSession())).toBeUndefined();
		});
	}

	test("an error status is no id, even with an id in the body", async () => {
		stubFetch(() => answer({ data: { id: 42 } }, 500));
		expect(await reserveUserRow(uniqueSession())).toBeUndefined();
	});

	test("a network error is no id", async () => {
		stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		expect(await reserveUserRow(uniqueSession())).toBeUndefined();
	});

	test("malformed JSON is no id", async () => {
		stubFetch(() => new Response("{data:", { status: 200, headers: { "content-type": "application/json" } }));
		expect(await reserveUserRow(uniqueSession())).toBeUndefined();
	});

	test("a missing service key is no id, not a throw", async () => {
		delete process.env.WANIWANI_SERVICE_PRIVATE_KEY;
		stubFetch(() => answer({ data: { id: 42 } }));
		expect(await reserveUserRow(uniqueSession())).toBeUndefined();
	});

	test("a hanging app is given up on after 1 s", async () => {
		stubFetch((call) => untilAborted(call.signal));
		const started = performance.now();
		expect(await reserveUserRow(uniqueSession())).toBeUndefined();
		const elapsed = performance.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(900);
		expect(elapsed).toBeLessThan(1_500);
	});

	test("an answer inside 1 s is kept", async () => {
		stubFetch(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			return answer({ data: { id: 9 } });
		});
		expect(await reserveUserRow(uniqueSession())).toBe(9);
	});
});
