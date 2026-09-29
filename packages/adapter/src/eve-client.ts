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
export type EveEvent = {
	readonly type: string;
	readonly data?: unknown;
	readonly meta?: { readonly deliveryIds?: readonly string[] };
};

/** The cursor locates events; the delivery id identifies the submitted message. */
export type EveDelivery = { startIndex: number; deliveryId?: string };

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
	/** `_meta` keys the caller stamps for the runtime's tool calls. */
	context?: Record<string, unknown>;
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

/** Header values must be Latin-1, so every other character goes out as a JSON `\u` escape. */
function jsonHeader(value: Record<string, unknown>): string {
	return JSON.stringify(value).replace(
		/[\u007f-\uffff]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
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
		...(target.extra ? { "x-waniwani-extra": jsonHeader(target.extra) } : {}),
		...(target.context ? { "x-waniwani-context": jsonHeader(target.context) } : {}),
	};
}

async function failure(response: Response): Promise<EveError> {
	const detail = await response.text().catch(() => "");
	return new EveError(response.status, detail || response.statusText);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

async function postTurn(
	target: EveTarget,
	path: string,
	body: EveTurnBody & { turnPolicy?: "steer" },
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
 * Submit a follow-up with an explicit interrupt policy and a correlated response.
 * `from` is a stream position the caller already consumed up to; with it, the
 * stream is read from there and filtered by the delivery id, so the tail read
 * is skipped. Any position at or before the tail is safe, since events that
 * belong to other deliveries are dropped.
 */
export async function continueEveSession(
	target: EveTarget,
	sessionId: string,
	body: EveTurnBody,
	from?: number,
): Promise<EveDelivery & { deliveryId: string }> {
	let delay = BASE_DELAY_MS;
	for (let attempt = 1; ; attempt += 1) {
		const startIndex = from ?? (await streamTailIndex(target, sessionId)) + 1;
		try {
			const response = await postTurn(
				target, sessionPath(sessionId), { ...body, turnPolicy: "steer" }, sessionId,
			);
			const accepted = await response.json() as { deliveryId?: unknown };
			if (typeof accepted.deliveryId !== "string" || !accepted.deliveryId.trim()) {
				throw new EveError(0, "Runtime returned no delivery id; update Eve before continuing sessions");
			}
			return { startIndex, deliveryId: accepted.deliveryId };
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
	const request = new AbortController();
	const response = await fetch(url, {
		cache: "no-store",
		headers: await headersFor(target, sessionId),
		signal: request.signal,
	});
	try {
		if (!response.ok) throw await failure(response);
		const tail = Number(response.headers.get("x-eve-stream-tail-index"));
		return Number.isSafeInteger(tail) ? tail : -1;
	} finally {
		// A waiting session's stream never ends, and inside a Next.js route handler
		// `body.cancel()` on it never settles, so the read is aborted instead.
		request.abort();
	}
}

export async function openEveStream(input: {
	target: EveTarget;
	sessionId: string;
	startIndex: number;
	deliveryId?: string;
	onEvent?: (event: EveEvent) => void;
	/** The position after the last line read, whether its event was kept or filtered out. */
	onPosition?: (next: number) => void;
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
		if (response.ok && response.body) {
			return ndjson(response.body, {
				startIndex,
				deliveryId: input.deliveryId,
				onEvent: input.onEvent,
				onPosition: input.onPosition,
			});
		}
		last = await failure(response);
		if (!RETRYABLE.has(response.status)) throw last;
		await sleep(delay, signal);
		delay = Math.min(delay * 2, MAX_DELAY_MS);
	}
	throw last ?? new EveError(0, "Could not open the session stream");
}

export async function cancelEveTurn(
	target: EveTarget,
	sessionId: string,
	turnId?: string,
	signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<void> {
	const response = await fetch(route(target, sessionPath(sessionId, "/cancel")), {
		method: "POST",
		headers: { ...(await headersFor(target, sessionId)), "content-type": "application/json" },
		body: JSON.stringify(turnId === undefined ? {} : { turnId }),
		signal,
	});
	if (!response.ok) throw await failure(response);
	await response.body?.cancel().catch(() => {});
}

/** One event per line, ending only at the submitted message's own boundary. */
function ndjson(
	body: ReadableStream<Uint8Array>,
	options: {
		startIndex: number;
		deliveryId?: string;
		onEvent?: (event: EveEvent) => void;
		onPosition?: (next: number) => void;
	},
): ReadableStream<EveEvent> {
	const { deliveryId, onEvent, onPosition } = options;
	let position = options.startIndex;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eof = false;
	let started = deliveryId === undefined;

	return new ReadableStream<EveEvent>({
		async pull(controller) {
			try {
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline === -1 && !eof) {
						const { done, value } = await reader.read();
						eof = done;
						buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
						continue;
					}
					const line = (newline === -1 ? buffer : buffer.slice(0, newline)).trim();
					buffer = newline === -1 ? "" : buffer.slice(newline + 1);
					if (!line) {
						if (eof && !buffer) throw new EveError(0, "The session stream ended before the turn did");
						continue;
					}
					const event = JSON.parse(line) as EveEvent;
					position += 1;
					onPosition?.(position);
					if (deliveryId !== undefined) {
						// Mirror Eve's delivery filter, including session-wide terminal errors.
						const matches = event.meta?.deliveryIds?.includes(deliveryId) === true;
						const terminal = event.type === "session.failed" || event.type === "session.completed";
						if (!matches && terminal && (!started || event.type === "session.completed")) {
							throw new EveError(0, "The session ended before the accepted message reached its turn boundary");
						}
						if (!started && !matches) continue;
						if (!terminal && event.meta?.deliveryIds !== undefined && !matches) continue;
						started = true;
					}
					onEvent?.(event);
					controller.enqueue(event);
					if (TURN_BOUNDARY.has(event.type)) {
						await reader.cancel().catch(() => {});
						controller.close();
					}
					return;
				}
			} catch (error) {
				await reader.cancel(error).catch(() => {});
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason).catch(() => {});
		},
	});
}
