import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { type ReportEvent, report, userRowStored } from "./reporting.js";

type Call = { url: URL; method: string; authorization: string | null; body: Record<string, unknown> };

const API_URL = "http://app.test";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PRIVATE_PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const originalFetch = globalThis.fetch;
const ENV_KEYS = ["WANIWANI_API_URL", "WANIWANI_SERVICE_PRIVATE_KEY", "WANIWANI_REGION"] as const;
const saved = new Map<string, string | undefined>();

let calls: Call[] = [];
let sequence = 0;

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
			};
			calls.push(call);
			return await answer(call, calls.length - 1);
		},
		{ preconnect: originalFetch.preconnect },
	);
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) throw new Error("condition never held");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function settle(ms = 50): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function userMessage(turnId: string, text = "hello"): ReportEvent {
	return { kind: "user_message", eventId: `eve_u_${turnId}`, occurredAt: "2026-09-29T10:00:00.000Z", turnId, text };
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

function barrierCalls(): Call[] {
	return calls.filter((call) => call.body.barrier !== undefined);
}

beforeEach(() => {
	for (const key of ENV_KEYS) saved.set(key, process.env[key]);
	process.env.WANIWANI_API_URL = API_URL;
	process.env.WANIWANI_SERVICE_PRIVATE_KEY = PRIVATE_PEM;
	process.env.WANIWANI_REGION = "us";
	calls = [];
});

afterEach(() => {
	globalThis.fetch = originalFetch;
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

describe("report: order within one session", () => {
	test("a later report waits for an earlier one still in flight", async () => {
		const first = deferred<Response>();
		stubFetch((_call, index) => (index === 0 ? first.promise : Response.json({ ok: true })));
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		await waitFor(() => calls.length >= 1);
		await settle(100);
		expect(calls).toHaveLength(1);
		first.resolve(Response.json({ ok: true }));
		expect(await a).toBe(true);
		expect(await b).toBe(true);
		expect(calls.map(eventIdsOf)).toEqual([["eve_u_turn_1"], ["eve_a_turn_1"]]);
	});

	test("three reports land in the order they were made", async () => {
		const gates = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
		stubFetch((_call, index) => gates[index]?.promise ?? Response.json({ ok: true }));
		const session = uniqueSession();
		const all = Promise.all([
			report(session, [userMessage("t1")]),
			report(session, [assistantMessage("t1")]),
			report(session, [userMessage("t2")]),
		]);
		await waitFor(() => calls.length >= 1);
		gates[0]?.resolve(Response.json({ ok: true }));
		await waitFor(() => calls.length >= 2);
		await settle(50);
		expect(calls).toHaveLength(2);
		gates[1]?.resolve(Response.json({ ok: true }));
		await waitFor(() => calls.length >= 3);
		gates[2]?.resolve(Response.json({ ok: true }));
		await all;
		expect(calls.map(eventIdsOf)).toEqual([["eve_u_t1"], ["eve_a_t1"], ["eve_u_t2"]]);
	});

	test("a later report waits for an earlier one's retries", async () => {
		stubFetch((_call, index) =>
			index === 0 ? new Response("busy", { status: 503 }) : Response.json({ ok: true }),
		);
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		expect(await a).toBe(true);
		expect(await b).toBe(true);
		expect(calls.map(eventIdsOf)).toEqual([["eve_u_turn_1"], ["eve_u_turn_1"], ["eve_a_turn_1"]]);
	}, 10_000);

	test("a refused earlier report does not stop a later one", async () => {
		stubFetch((_call, index) =>
			index === 0 ? new Response("bad", { status: 400 }) : Response.json({ ok: true }),
		);
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		expect(await a).toBe(false);
		expect(await b).toBe(true);
		expect(calls.map(eventIdsOf)).toEqual([["eve_u_turn_1"], ["eve_a_turn_1"]]);
	});

	test("an earlier report that exhausts its retries does not stop a later one", async () => {
		stubFetch((call) => {
			if (eventIdsOf(call)[0] === "eve_u_turn_1") throw new TypeError("fetch failed");
			return Response.json({ ok: true });
		});
		const session = uniqueSession();
		const a = report(session, [userMessage("turn_1")]);
		const b = report(session, [assistantMessage("turn_1")]);
		expect(await a).toBe(false);
		expect(await b).toBe(true);
		const ids = calls.map((call) => eventIdsOf(call)[0]);
		expect(ids.lastIndexOf("eve_u_turn_1")).toBeLessThan(ids.indexOf("eve_a_turn_1"));
	}, 10_000);
});

describe("report: retries", () => {
	test("a network error is retried until it succeeds", async () => {
		stubFetch((_call, index) => {
			if (index === 0) throw new TypeError("fetch failed");
			return Response.json({ ok: true });
		});
		expect(await report(uniqueSession(), [userMessage("t")])).toBe(true);
		expect(calls).toHaveLength(2);
	}, 10_000);

	test("a 500 is retried until it succeeds", async () => {
		stubFetch((_call, index) => (index < 2 ? new Response("oops", { status: 500 }) : Response.json({ ok: true })));
		expect(await report(uniqueSession(), [userMessage("t")])).toBe(true);
		expect(calls).toHaveLength(3);
	}, 10_000);

	test("a 429 is retried", async () => {
		stubFetch((_call, index) => (index === 0 ? new Response("slow down", { status: 429 }) : Response.json({ ok: true })));
		expect(await report(uniqueSession(), [userMessage("t")])).toBe(true);
		expect(calls).toHaveLength(2);
	}, 10_000);

	test("a persistent 503 stops after 4 attempts and reports failure", async () => {
		stubFetch(() => new Response("down", { status: 503 }));
		expect(await report(uniqueSession(), [userMessage("t")])).toBe(false);
		await settle(100);
		expect(calls).toHaveLength(4);
	}, 10_000);

	test("a persistent network error stops after 4 attempts and reports failure", async () => {
		stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		expect(await report(uniqueSession(), [userMessage("t")])).toBe(false);
		await settle(100);
		expect(calls).toHaveLength(4);
	}, 10_000);

	for (const status of [400, 401, 403, 404, 409, 422]) {
		test(`a ${status} is not retried`, async () => {
			stubFetch(() => new Response("no", { status }));
			expect(await report(uniqueSession(), [userMessage("t")])).toBe(false);
			await settle(300);
			expect(calls).toHaveLength(1);
		});
	}

	test("every retry carries the same event ids", async () => {
		stubFetch((_call, index) => (index < 2 ? new Response("oops", { status: 502 }) : Response.json({ ok: true })));
		await report(uniqueSession(), [userMessage("t"), assistantMessage("t")]);
		expect(calls.map(eventIdsOf)).toEqual([
			["eve_u_t", "eve_a_t"],
			["eve_u_t", "eve_a_t"],
			["eve_u_t", "eve_a_t"],
		]);
	}, 10_000);
});

function barrierAnswer(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("userRowStored", () => {
	test("while this process is delivering the user row, it waits for that delivery and answers true", async () => {
		const gate = deferred<Response>();
		stubFetch((call) => (call.body.barrier !== undefined ? barrierAnswer({ data: { stored: false } }) : gate.promise));
		const session = uniqueSession();
		void report(session, [userMessage("turn_1")]);
		let answered = false;
		const stored = userRowStored({ ...session, turnId: "turn_1" }).then((value) => {
			answered = true;
			return value;
		});
		await settle(100);
		expect(answered).toBe(false);
		gate.resolve(Response.json({ ok: true }));
		expect(await stored).toBe(true);
		expect(barrierCalls()).toHaveLength(0);
	});

	test("while this process is delivering the user row and the app refuses it, it answers false without asking", async () => {
		const gate = deferred<Response>();
		stubFetch((call) => (call.body.barrier !== undefined ? barrierAnswer({ data: { stored: true } }) : gate.promise));
		const session = uniqueSession();
		void report(session, [userMessage("turn_1")]);
		const stored = userRowStored({ ...session, turnId: "turn_1" });
		gate.resolve(new Response("bad", { status: 400 }));
		expect(await stored).toBe(false);
		expect(barrierCalls()).toHaveLength(0);
	});

	test("after this process delivered the user row, it answers from that delivery without asking the app", async () => {
		stubFetch((call) => (call.body.barrier !== undefined ? barrierAnswer({ data: { stored: true } }) : Response.json({ ok: true })));
		const session = uniqueSession();
		expect(await report(session, [userMessage("turn_1")])).toBe(true);
		await settle();
		expect(await userRowStored({ ...session, turnId: "turn_1" })).toBe(true);
		expect(barrierCalls()).toHaveLength(0);
	});

	test("after this process failed to deliver the user row, it answers false", async () => {
		stubFetch((call) =>
			call.body.barrier !== undefined ? barrierAnswer({ data: { stored: true } }) : new Response("bad", { status: 400 }),
		);
		const session = uniqueSession();
		expect(await report(session, [userMessage("turn_1")])).toBe(false);
		await settle();
		expect(await userRowStored({ ...session, turnId: "turn_1" })).toBe(false);
	});

	test("with no local delivery it asks the app with a barrier for the turn", async () => {
		stubFetch(() => barrierAnswer({ data: { stored: true } }));
		const session = uniqueSession();
		expect(await userRowStored({ ...session, turnId: "turn_9" })).toBe(true);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url.searchParams.get("environmentId")).toBe(session.environmentId);
		expect(calls[0]?.authorization?.startsWith("Bearer ")).toBe(true);
		expect(calls[0]?.body).toEqual({ sessionId: session.sessionId, barrier: { turnId: "turn_9" } });
	});

	test("the app answering stored false is false", async () => {
		stubFetch(() => barrierAnswer({ data: { stored: false } }));
		expect(await userRowStored({ ...uniqueSession(), turnId: "t" })).toBe(false);
	});

	test("the app answering stored as a string is false", async () => {
		stubFetch(() => barrierAnswer({ data: { stored: "true" } }));
		expect(await userRowStored({ ...uniqueSession(), turnId: "t" })).toBe(false);
	});

	test("stored at the top level instead of under data is false", async () => {
		stubFetch(() => barrierAnswer({ stored: true }));
		expect(await userRowStored({ ...uniqueSession(), turnId: "t" })).toBe(false);
	});

	test("data null is false", async () => {
		stubFetch(() => barrierAnswer({ data: null }));
		expect(await userRowStored({ ...uniqueSession(), turnId: "t" })).toBe(false);
	});

	test("an error status is false, even with stored true in the body", async () => {
		stubFetch(() => barrierAnswer({ data: { stored: true } }, 500));
		expect(await userRowStored({ ...uniqueSession(), turnId: "t" })).toBe(false);
	});

	test("a network error is false", async () => {
		stubFetch(() => {
			throw new TypeError("fetch failed");
		});
		expect(await userRowStored({ ...uniqueSession(), turnId: "t" })).toBe(false);
	});

	test("malformed JSON is false", async () => {
		stubFetch(() => new Response("{data:", { status: 200, headers: { "content-type": "application/json" } }));
		expect(await userRowStored({ ...uniqueSession(), turnId: "t" })).toBe(false);
	});

	test("a missing service key is false, not a throw", async () => {
		delete process.env.WANIWANI_SERVICE_PRIVATE_KEY;
		stubFetch(() => barrierAnswer({ data: { stored: true } }));
		expect(await userRowStored({ ...uniqueSession(), turnId: "t" })).toBe(false);
	});

	test("a local delivery for one turn does not answer for another turn", async () => {
		const gate = deferred<Response>();
		stubFetch((call) => (call.body.barrier !== undefined ? barrierAnswer({ data: { stored: false } }) : gate.promise));
		const session = uniqueSession();
		void report(session, [userMessage("turn_1")]);
		expect(await userRowStored({ ...session, turnId: "turn_2" })).toBe(false);
		expect(barrierCalls()).toHaveLength(1);
		gate.resolve(Response.json({ ok: true }));
	});

	test("a local delivery in one session does not answer for the same turn id in another session", async () => {
		const gate = deferred<Response>();
		stubFetch((call) => (call.body.barrier !== undefined ? barrierAnswer({ data: { stored: false } }) : gate.promise));
		const first = uniqueSession();
		const second = uniqueSession();
		void report(first, [userMessage("turn_1")]);
		expect(await userRowStored({ ...second, turnId: "turn_1" })).toBe(false);
		expect(barrierCalls()).toHaveLength(1);
		expect(barrierCalls()[0]?.body.sessionId).toBe(second.sessionId);
		gate.resolve(Response.json({ ok: true }));
	});

	test("an assistant message alone is no local user row, so the app is asked", async () => {
		const gate = deferred<Response>();
		stubFetch((call) => (call.body.barrier !== undefined ? barrierAnswer({ data: { stored: true } }) : gate.promise));
		const session = uniqueSession();
		void report(session, [assistantMessage("turn_1")]);
		expect(await userRowStored({ ...session, turnId: "turn_1" })).toBe(true);
		expect(barrierCalls()).toHaveLength(1);
		gate.resolve(Response.json({ ok: true }));
	});
});
