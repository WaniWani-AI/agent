/**
 * Live continuation regression test against the real PostgreSQL runtime.
 * Start an isolated self-hosted compose.ci.yaml stack, then run:
 *   bun run test/continuation.ts
 * Uses real Eve + the adapter, with a gated OpenAI-compatible model.
 * The race case pauses only the client's tail-read response, never Eve itself.
 */
import assert from "node:assert/strict";
import { runTurn } from "../packages/adapter/src/core.ts";

const EVE = "http://127.0.0.1:3001";
const APP = "http://127.0.0.1:3004";
const nativeFetch = globalThis.fetch;
const headers = { authorization: "Bearer wwk_test", "content-type": "application/json" };
const reports: unknown[] = [];
type Event = { type: string; data?: Record<string, any>; meta?: Record<string, any> };
type Call = { messages: any[]; release: () => void; finished: boolean; answer: string; startedAt: number; connectionAborted: boolean };
const calls: Call[] = [];

async function until(check: () => boolean, label: string) {
	const deadline = Date.now() + 30_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await Bun.sleep(10);
	}
}

// Keep A's model response in flight until the test explicitly releases it.
// B's response completes immediately. Record the actual messages Eve sends.
const model = Bun.serve({
	hostname: "0.0.0.0",
	port: 13005,
	idleTimeout: 60,
	async fetch(request) {
		const body = await request.json() as { messages: any[]; model: string };
		const users = body.messages.filter((message) => message.role === "user");
		const last = JSON.stringify(users.at(-1));
		const isB = last.includes("FOLLOW_UP_B");
		const isC = last.includes("FOLLOW_UP_C");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const call: Call = { messages: body.messages, release, finished: false, answer: isC ? "ANSWER_C" : isB ? "ANSWER_B" : "ANSWER_A", startedAt: Date.now(), connectionAborted: false };
		calls.push(call);
		request.signal.addEventListener("abort", () => { call.connectionAborted = true; });
		const encoder = new TextEncoder();
		const frame = (delta: unknown, finish_reason: string | null = null) => encoder.encode(
			`data: ${JSON.stringify({ id: "race-fixture", object: "chat.completion.chunk", created: 1, model: body.model,
				choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
		);
		return new Response(new ReadableStream({
			async start(controller) {
				let pulse: ReturnType<typeof setInterval> | undefined;
				try {
					controller.enqueue(frame({ role: "assistant", content: call.answer }));
					if ((!isB && !isC) || last.includes("rapid")) {
						pulse = setInterval(() => {
							try { controller.enqueue(frame({ content: "." })); }
							catch { clearInterval(pulse); }
						}, 50);
						await gate;
					}
					controller.enqueue(frame({}, "stop"));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				} catch { /* Steering may already have cancelled the model connection. */ }
				finally { clearInterval(pulse); call.finished = true; }
			},
		}), { headers: { "content-type": "text/event-stream" } });
	},
});

async function configure(baseUrl: string) {
	const response = await nativeFetch(`${APP}/_control`, {
		method: "POST", headers,
		body: JSON.stringify({ failing: false, model: {
			mode: "byo", provider: "litellm", modelId: "fixture/model", baseUrl,
			supportsStructuredOutputs: false, providerOptions: null,
		} }),
	});
	assert.equal(response.status, 200);
}

async function watch(sessionId: string) {
	let response: Response | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		response = await nativeFetch(`${EVE}/eve/v1/session/${sessionId}/stream`, { headers });
		if (response.ok) break;
		await response.body?.cancel();
		await Bun.sleep(100);
	}
	assert(response?.ok && response.body, "Could not open raw Eve event stream");
	const reader = response.body.getReader();
	const events: Event[] = [];
	let failure: unknown;
	const done = (async () => {
		let buffer = "";
		const decoder = new TextDecoder();
		for (;;) {
			const next = await reader.read();
			if (next.done) return;
			buffer += decoder.decode(next.value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) events.push(JSON.parse(line));
			}
		}
	})().catch((error) => { failure = error; });
	return { events, async close() { await reader.cancel(); await done; if (failure) throw failure; } };
}

async function scenario(kind: "settled" | "race" | "steer", iteration: number) {
	const firstMessage = `INITIAL_A ${kind} ${iteration}`;
	const secondMessage = `FOLLOW_UP_B ${kind} ${iteration}`;
	const callOffset = calls.length;
	const created = await nativeFetch(`${EVE}/eve/v1/session`, {
		method: "POST", headers, body: JSON.stringify({ message: firstMessage }),
	});
	assert.equal(created.status, 202);
	const { sessionId } = await created.json() as { sessionId: string };
	console.log(`START ${kind} ${iteration}: ${sessionId}`);
	const raw = await watch(sessionId);
	let tail: number | undefined;
	let acceptedAt: number | undefined;
	const abort = new AbortController();
	const deadline = setTimeout(() => abort.abort(new Error("Adapter stream timed out")), 30_000);
	deadline.unref();
	try {
		await until(() => raw.events.some((event) => event.type === "message.appended"), "A streaming");
		const firstCall = calls[callOffset]!;
		assert.equal(firstCall.finished, false);
		assert(!raw.events.some((event) => event.type === "session.waiting"));
		const firstTurn = raw.events.find((event) => event.type === "turn.started")!.data!.turnId;
		if (kind === "settled") {
			firstCall.release();
			await until(() => raw.events.some((event) => event.type === "session.waiting"), "A settled");
		}
		let accepted: unknown;
		globalThis.fetch = (async (input: any, init?: RequestInit) => {
			const response = await nativeFetch(input, init);
			const url = String(input);
			if (url.includes(sessionId) && url.includes("includeTailIndex=1")) {
				tail = Number(response.headers.get("x-eve-stream-tail-index"));
				if (kind === "race") {
					// A is still running when the real server captures the tail.
					assert.equal(firstCall.finished, false);
					firstCall.release();
					await until(() => raw.events.some((event) => event.type === "session.waiting"), "A parks between tail and POST");
				}
			}
			if (url.endsWith(`/session/${sessionId}`) && init?.method === "POST") {
				accepted = await response.clone().json();
				acceptedAt = Date.now();
				console.log(`POST accepted for ${kind} ${iteration}`);
			}
			return response;
		}) as typeof fetch;
		const turn = await runTurn({ eveUrl: EVE, credential: "wwk_test", sessionId, message: secondMessage,
			signal: abort.signal });
		const chunks: any[] = [];
		for await (const chunk of turn.chunks) chunks.push(chunk);
		globalThis.fetch = nativeFetch;
		const adapterText = chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("");
		await until(() => {
			const bIndex = raw.events.findIndex((event) => event.type === "message.appended" && event.data?.messageDelta === "ANSWER_B");
			return bIndex >= 0 && raw.events.slice(bIndex).some((event) => event.type === "session.waiting");
		}, "B settles in Eve");
		const started = raw.events.filter((event) => event.type === "turn.started");
		const secondTurn = raw.events.find((event) => event.type === "message.appended" && event.data?.messageDelta === "ANSWER_B")!.data!.turnId;
		const received = raw.events.filter((event) => event.type === "message.received");
		const runtimeText = raw.events.filter((event) => event.type === "message.appended" && event.data?.turnId === secondTurn)
			.map((event) => event.data!.messageDelta).join("");
		assert(runtimeText.includes("ANSWER_B"));
		const bCall = calls.slice(callOffset).find((call) => call.answer === "ANSWER_B")!;
		const bUsers = JSON.stringify(bCall.messages.filter((message) => message.role === "user"));
		assert(bUsers.includes(secondMessage), "Replacement model request lost B");
		if (kind !== "steer") {
			assert.equal(started.length, 2);
			assert.notEqual(firstTurn, secondTurn);
			assert.equal(received.length, 2);
			assert.equal(received[1]!.data!.message, secondMessage);
			assert.equal(received[1]!.data!.turnId, secondTurn);
			assert(bUsers.includes(firstMessage), "Replacement model request lost A");
		}
		assert.equal(adapterText, "ANSWER_B");
		assert(bUsers.includes(firstMessage), "Replacement lost the original user input");
		if (kind === "steer") {
			assert.equal(firstCall.finished, false, "Replacement waited for the original model response to finish");
			await until(() => firstCall.connectionAborted, "Original model connection aborts");
		}
		const report = { kind, iteration, sessionId, tail, accepted, adapterText, runtimeText,
			runtimeVersion: raw.events.find((event) => event.type === "session.started")?.data?.runtime?.eveVersion,
			replacementDelayMs: acceptedAt === undefined ? undefined : bCall.startedAt - acceptedAt,
			replacementBeforeOriginalFinished: !firstCall.finished,
			originalModelConnectionAborted: firstCall.connectionAborted,
			bothUserMessagesInReplacement: bUsers.includes(firstMessage) && bUsers.includes(secondMessage),
			initialMessageAnywhereInReplacement: JSON.stringify(bCall.messages).includes(firstMessage),
			replacementMessages: bCall.messages,
			firstTurn, secondTurn, turnStartedCount: started.length, messageReceivedCount: received.length,
			cancelled: raw.events.some((event) => event.type === "turn.cancelled"), replacementUserMessages: JSON.parse(bUsers),
			events: raw.events.map((event, index) => ({ index, type: event.type, turnId: event.data?.turnId, message: event.data?.message, deliveryIds: event.meta?.deliveryIds, at: event.meta?.at })) };
		reports.push(report);
		await Bun.write("/tmp/agent-continuation-results.json", JSON.stringify(reports, null, 2));
		console.log(JSON.stringify({ kind, iteration, adapterText, replacementDelayMs: report.replacementDelayMs }));
	} catch (error) {
		console.error(JSON.stringify({ kind, iteration, tail, events: raw.events, calls: calls.slice(callOffset).map(({ messages, finished }) => ({ messages, finished })) }, null, 2));
		throw error;
	} finally {
		clearTimeout(deadline);
		globalThis.fetch = nativeFetch;
		for (const call of calls.slice(callOffset)) call.release();
		await raw.close();
		await nativeFetch(`${EVE}/eve/v1/session/${sessionId}/cancel`, { method: "POST", headers, body: "{}" });
	}
}

async function rapidFollowUps() {
	const offset = calls.length;
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), 30_000);
	let sessionId: string | undefined;
	const drain = async (turn: Awaited<ReturnType<typeof runTurn>>) => {
		const chunks = [];
		for await (const chunk of turn.chunks) chunks.push(chunk);
		return chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta).join("");
	};
	try {
		const a = await runTurn({ eveUrl: EVE, credential: "wwk_test", message: "INITIAL_A rapid", signal: abort.signal });
		sessionId = a.sessionId;
		const aText = drain(a);
		await until(() => calls.length > offset, "A model starts");
		const b = await runTurn({ eveUrl: EVE, credential: "wwk_test", sessionId, message: "FOLLOW_UP_B rapid", signal: abort.signal });
		const bText = drain(b);
		// Submit C while A's cancellation or B's model call is still in flight.
		// Eve may batch B+C or start C as another replacement; both must be safe.
		const c = await runTurn({ eveUrl: EVE, credential: "wwk_test", sessionId, message: "FOLLOW_UP_C rapid", signal: abort.signal });
		const cText = drain(c);
		await until(() => calls.slice(offset).some((call) => call.answer === "ANSWER_C"), "C model starts");
		const cCall = calls.slice(offset).find((call) => call.answer === "ANSWER_C")!;
		await Promise.all([a.cancel(), b.cancel()]);
		// Let the asynchronous cancel commands settle while C is still generating.
		await Bun.sleep(1_500);
		assert.equal(cCall.connectionAborted, false, "Old response cleanup aborted C");
		cCall.release();
		assert.match(await cText, /^ANSWER_C\.*$/);
		await Promise.all([aText, bText]);
		const replacement = calls.slice(offset).find((call) => call.answer === "ANSWER_C")!;
		const users = JSON.stringify(replacement.messages.filter((message) => message.role === "user"));
		for (const input of ["INITIAL_A rapid", "FOLLOW_UP_B rapid", "FOLLOW_UP_C rapid"]) {
			assert(users.includes(input), `Rapid replacement lost ${input}`);
		}
		assert.equal(calls[offset]!.finished, false);
		await until(() => calls[offset]!.connectionAborted, "Rapid follow-up aborts A");
		console.log("PASS rapid A/B/C: latest answer retains all messages and survives old response cleanup");
	} finally {
		clearTimeout(timeout);
		abort.abort();
		for (const call of calls.slice(offset)) call.release();
		if (sessionId) await nativeFetch(`${EVE}/eve/v1/session/${sessionId}/cancel`, { method: "POST", headers, body: "{}" });
	}
}

async function saturatedWorkers() {
	// Both Compose configurations give ordinary jobs five worker slots.
	const workers = 5;
	const offset = calls.length;
	const sessions: string[] = [];
	const readers: Awaited<ReturnType<typeof watch>>[] = [];
	const abort = new AbortController();
	const timeout = setTimeout(() => abort.abort(), 30_000);
	try {
		for (let i = 0; i < workers; i++) {
			const created = await nativeFetch(`${EVE}/eve/v1/session`, {
				method: "POST", headers, body: JSON.stringify({ message: `INITIAL_A saturated ${i}` }),
			});
			assert.equal(created.status, 202);
			const { sessionId } = await created.json() as { sessionId: string };
			sessions.push(sessionId);
			readers.push(await watch(sessionId));
		}
		await until(() => calls.length === offset + workers, "All model workers occupied");
		const originals = calls.slice(offset);
		assert(originals.every((call) => !call.finished && !call.connectionAborted));
		const turn = await runTurn({
			eveUrl: EVE, credential: "wwk_test", sessionId: sessions[0],
			message: "FOLLOW_UP_B saturated", signal: abort.signal,
		});
		let text = "";
		for await (const chunk of turn.chunks) if (chunk.type === "text-delta") text += chunk.delta;
		assert.equal(text, "ANSWER_B");
		const interrupted = originals.find((call) => JSON.stringify(call.messages).includes("INITIAL_A saturated 0"))!;
		await until(() => interrupted.connectionAborted, "Saturated model call interrupted");
		assert(originals.every((call) => !call.finished), "A model had to finish to free cancellation capacity");
		assert(originals.filter((call) => call !== interrupted).every((call) => !call.connectionAborted));
		const replacement = calls.slice(offset).find((call) => call.answer === "ANSWER_B")!;
		assert(JSON.stringify(replacement.messages).includes("INITIAL_A saturated 0"));
		console.log("PASS saturated workers: follow-up interrupts while all five model slots are occupied");
	} finally {
		clearTimeout(timeout);
		abort.abort();
		for (const call of calls.slice(offset)) call.release();
		for (const reader of readers) await reader.close();
		for (const sessionId of sessions) {
			await nativeFetch(`${EVE}/eve/v1/session/${sessionId}/cancel`, { method: "POST", headers, body: "{}" });
		}
	}
}

try {
	await configure("http://host.docker.internal:13005/v1");
	const kinds = ["settled", "race", "steer"] as const;
	for (const kind of kinds) {
		for (let iteration = 1; iteration <= (kind === "settled" ? 1 : 3); iteration++) {
			await scenario(kind, iteration);
		}
	}
	await rapidFollowUps();
	await saturatedWorkers();
	await Bun.write("/tmp/agent-continuation-results.json", JSON.stringify(reports, null, 2));
	console.log(`Completed ${reports.length} continuation scenarios plus rapid follow-ups and saturated workers; see /tmp/agent-continuation-results.json.`);
} finally {
	globalThis.fetch = nativeFetch;
	for (const call of calls) call.release();
	await configure("http://model:3003/v1");
	model.stop(true);
}

// This standalone integration test owns all its sockets. Bun 1.3.9 can retain
// cancelled streaming HTTP connections after the server and readers close.
process.exit(0);
