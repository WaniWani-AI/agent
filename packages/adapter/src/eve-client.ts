/**
 * The runtime's wire protocol over `fetch`: five routes, and no `eve`
 * dependency, since this package installs into a customer's MCP server. With
 * `ui-stream.ts`, the only file here that knows the runtime is Eve.
 */

/**
 * `isCurrentTurnBoundaryEvent` in the runtime's own client. `turn.completed` is
 * not one: the session parks an event later, and stopping short of that leaves
 * the next continuation starting on a boundary that was never its own.
 */
const TURN_BOUNDARY = new Set([
	"session.completed",
	"session.failed",
	"session.waiting",
]);

/** A session the runtime has just created is not always streamable yet. */
const RETRYABLE = new Set([404, 409, 425, 500, 502, 503, 504]);
const OPEN_ATTEMPTS = 12;
const SEND_ATTEMPTS = 5;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 4_000;

/** One NDJSON line off the session stream. */
export type EveEvent = { readonly type: string; readonly data?: unknown };

/**
 * What the runtime is given as `Authorization`. A self-hosted router presents
 * the environment key, so one string covers every request; a hosted caller
 * mints a token bound to the session it addresses, hence the function form.
 */
export type Credential = string | ((sessionId?: string) => string | Promise<string>);

export type EveTarget = {
	eveUrl: string;
	credential: Credential;
	visitorId?: string;
	extra?: Record<string, unknown>;
};

export type EveTurnBody = {
	message: string;
	clientContext?: string | string[] | Record<string, unknown>;
};

/** Carries the runtime's status, so a caller can tell an unknown session from an outage. */
export class EveError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "EveError";
		this.status = status;
	}
}

function route(target: EveTarget, path: string, query?: Record<string, string>): string {
	const url = new URL(`${target.eveUrl.replace(/\/+$/, "")}/eve/v1${path}`);
	for (const [name, value] of Object.entries(query ?? {})) {
		url.searchParams.set(name, value);
	}
	return url.toString();
}

function sessionPath(sessionId: string, suffix = ""): string {
	return `/session/${encodeURIComponent(sessionId)}${suffix}`;
}

async function headersFor(
	target: EveTarget,
	sessionId?: string,
): Promise<Record<string, string>> {
	const { credential } = target;
	const bearer = typeof credential === "string" ? credential : await credential(sessionId);
	return {
		authorization: `Bearer ${bearer}`,
		...(target.visitorId ? { "x-waniwani-visitor": target.visitorId } : {}),
		...(target.extra ? { "x-waniwani-extra": JSON.stringify(target.extra) } : {}),
	};
}

async function failure(response: Response): Promise<EveError> {
	const detail = await response.text().catch(() => "");
	return new EveError(response.status, detail || response.statusText);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postTurn(
	target: EveTarget,
	path: string,
	body: EveTurnBody,
	sessionId?: string,
): Promise<Response> {
	const response = await fetch(route(target, path), {
		method: "POST",
		headers: { ...(await headersFor(target, sessionId)), "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) throw await failure(response);
	return response;
}

export async function eveHealth(target: EveTarget): Promise<unknown> {
	const response = await fetch(route(target, "/health"), {
		headers: await headersFor(target),
	});
	if (!response.ok) throw await failure(response);
	return await response.json();
}

export async function createEveSession(
	target: EveTarget,
	body: EveTurnBody,
): Promise<string> {
	const response = await postTurn(target, "/session", body);
	const payload = (await response.json()) as { sessionId?: unknown };
	const sessionId =
		typeof payload.sessionId === "string" && payload.sessionId
			? payload.sessionId
			: response.headers.get("x-eve-session-id")?.trim();
	if (!sessionId) {
		throw new EveError(response.status, "Session route returned no session id");
	}
	return sessionId;
}

/**
 * Adds a turn to a session and answers the index its first event lands on. A
 * mid-turn message steers the running turn, so a 409 means a session that takes
 * no turn at all, and that turn appends while we ask, hence the tail re-read.
 */
export async function continueEveSession(
	target: EveTarget,
	sessionId: string,
	body: EveTurnBody,
): Promise<number> {
	let delay = BASE_DELAY_MS;
	for (let attempt = 1; ; attempt += 1) {
		const tail = await streamTailIndex(target, sessionId);
		try {
			const response = await postTurn(target, sessionPath(sessionId), body, sessionId);
			await response.body?.cancel().catch(() => {});
			return tail + 1;
		} catch (error) {
			const again =
				error instanceof EveError && error.status === 409 && attempt < SEND_ATTEMPTS;
			if (!again) throw error;
		}
		await sleep(delay);
		delay = Math.min(delay * 2, MAX_DELAY_MS);
	}
}

/**
 * The index of the session's last event, or `-1` on an empty stream. A 404 here
 * is where a caller learns the runtime does not know the session, so this read
 * does not retry.
 */
async function streamTailIndex(target: EveTarget, sessionId: string): Promise<number> {
	const url = route(target, sessionPath(sessionId, "/stream"), {
		startIndex: "0",
		includeTailIndex: "1",
	});
	const response = await fetch(url, {
		cache: "no-store",
		headers: await headersFor(target, sessionId),
	});
	await response.body?.cancel().catch(() => {});
	if (!response.ok) throw await failure(response);
	const tail = Number(response.headers.get("x-eve-stream-tail-index"));
	return Number.isSafeInteger(tail) ? tail : -1;
}

export async function openEveStream(input: {
	target: EveTarget;
	sessionId: string;
	startIndex: number;
	signal?: AbortSignal;
}): Promise<ReadableStream<EveEvent>> {
	const { target, sessionId, startIndex, signal } = input;
	const url = route(
		target,
		sessionPath(sessionId, "/stream"),
		startIndex === 0 ? undefined : { startIndex: String(startIndex) },
	);

	let delay = BASE_DELAY_MS;
	let last: EveError | undefined;
	for (let attempt = 1; attempt <= OPEN_ATTEMPTS; attempt += 1) {
		signal?.throwIfAborted();
		const response = await fetch(url, {
			cache: "no-store",
			headers: await headersFor(target, sessionId),
			...(signal ? { signal } : {}),
		});
		if (response.ok && response.body) return ndjson(response.body);
		last = await failure(response);
		if (!RETRYABLE.has(response.status)) throw last;
		await sleep(delay);
		delay = Math.min(delay * 2, MAX_DELAY_MS);
	}
	throw last ?? new EveError(0, "Could not open the session stream");
}

export async function cancelEveTurn(
	target: EveTarget,
	sessionId: string,
): Promise<void> {
	const response = await fetch(route(target, sessionPath(sessionId, "/cancel")), {
		method: "POST",
		headers: { ...(await headersFor(target, sessionId)), "content-type": "application/json" },
		body: "{}",
	});
	await response.body?.cancel().catch(() => {});
	if (!response.ok) throw await failure(response);
}

/** One event per line, ending at the boundary of the turn being read. */
function ndjson(body: ReadableStream<Uint8Array>): ReadableStream<EveEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let ended = false;

	return new ReadableStream<EveEvent>({
		async pull(controller) {
			const emit = async (line: string): Promise<void> => {
				const event = JSON.parse(line) as EveEvent;
				controller.enqueue(event);
				if (!TURN_BOUNDARY.has(event.type)) return;
				ended = true;
				await reader.cancel().catch(() => {});
				controller.close();
			};

			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline === -1) {
					const { done, value } = await reader.read();
					if (!done) {
						buffer += decoder.decode(value, { stream: true });
						continue;
					}
					const tail = buffer.trim();
					buffer = "";
					if (tail) await emit(tail);
					else if (ended) controller.close();
					// A body that stops before the turn does leaves a half-written
					// answer, which the browser would otherwise render as the whole of
					// one.
					else {
						controller.error(
							new EveError(0, "The session stream ended before the turn did"),
						);
					}
					return;
				}

				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				await emit(line);
				return;
			}
		},
		cancel(reason) {
			void reader.cancel(reason).catch(() => {});
		},
	});
}
