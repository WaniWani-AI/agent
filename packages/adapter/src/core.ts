import { type CryptoKey, importPKCS8, SignJWT } from "jose";
import {
	type Credential,
	type EveDelivery,
	type EveEvent,
	type EveTarget,
	type EveTurnBody,
	cancelEveTurn,
	continueEveSession,
	createEveSession,
	eveHealth,
	openEveStream,
} from "./eve-client.js";
import { type UIMessageChunk, uiMessageChunks } from "./ui-stream.js";

export { EveError } from "./eve-client.js";
export type { Credential, EveEvent } from "./eve-client.js";
export { withWidgetContext } from "./ui-stream.js";
export type { UIMessageChunk, WidgetContext } from "./ui-stream.js";

const TOKEN_LIFETIME_SECONDS = 300;

const signingKeys = new Map<string, Promise<CryptoKey>>();

/** A PEM pasted into Vercel's env editor can arrive with literal `\n` sequences. */
function signingKeyFor(pem: string): Promise<CryptoKey> {
	let key = signingKeys.get(pem);
	if (!key) {
		key = importPKCS8(pem.replaceAll("\\n", "\n"), "ES256");
		key.catch(() => signingKeys.delete(pem));
		signingKeys.set(pem, key);
	}
	return key;
}

/** One short-lived session token for the WaniWani-hosted runtime. */
export async function mintSessionToken(input: {
	/** PKCS8 PEM of the app's P-256 private key. */
	signingKey: string;
	sub: string;
	environmentId?: string;
	channelId?: string;
	/**
	 * The one session this token may address. The runtime authorizes no
	 * session-addressed route, so omit `sid` when creating a session and set it
	 * on every request that names one.
	 */
	sid?: string;
}): Promise<string> {
	const claims: Record<string, string> = {
		...(input.environmentId ? { environmentId: input.environmentId } : {}),
		...(input.channelId ? { channelId: input.channelId } : {}),
		...(input.sid ? { sid: input.sid } : {}),
	};
	return await new SignJWT(claims)
		.setProtectedHeader({ alg: "ES256" })
		.setIssuer("waniwani:agent")
		.setAudience("waniwani-agent-runtime")
		.setSubject(input.sub)
		.setIssuedAt()
		.setJti(crypto.randomUUID())
		.setExpirationTime(`${TOKEN_LIFETIME_SECONDS}s`)
		.sign(await signingKeyFor(input.signingKey));
}

export type RunTurnInput = {
	eveUrl: string;
	/** The environment key from a self-hosted router, or a hosted session token. */
	credential: Credential;
	visitorId?: string;
	message: string;
	/** Continues that session. Absent, the turn opens a new one. */
	sessionId?: string;
	/**
	 * The previous turn's `cursor()`, for a continuation. It spares a read of the
	 * stream's tail before submitting; absent, the tail is read.
	 */
	cursor?: number;
	clientContext?: string | string[] | Record<string, unknown>;
	extra?: Record<string, unknown>;
	/**
	 * `_meta` keys the caller stamps from its own authenticated state, such as
	 * `waniwani/documents`. The runtime keeps the keys it derives itself.
	 */
	context?: Record<string, unknown>;
	signal?: AbortSignal;
};

/**
 * Opens or continues a session and hands back the turn as it happens. Rejects
 * with an `EveError` carrying the runtime's status: 409 for a session id it
 * will not take a turn on, including one it has never heard of.
 */
export async function runTurn(input: RunTurnInput): Promise<{
	sessionId: string;
	/** Attaches to the session stream on first read; a failure to attach errors the stream. */
	chunks: ReadableStream<UIMessageChunk>;
	/** Stop this response's turn without cancelling a newer message. */
	cancel: () => Promise<void>;
	/** The stream position this response has read up to, for the next turn's `cursor`. */
	cursor: () => number;
}> {
	const target: EveTarget = {
		eveUrl: input.eveUrl,
		credential: input.credential,
		...(input.visitorId ? { visitorId: input.visitorId } : {}),
		...(input.extra ? { extra: input.extra } : {}),
		...(input.context ? { context: input.context } : {}),
	};
	const body: EveTurnBody = {
		message: input.message,
		...(input.clientContext !== undefined
			? { clientContext: input.clientContext }
			: {}),
	};

	input.signal?.throwIfAborted();

	// The submission takes no signal on purpose: a POST cancelled in flight may
	// still have been accepted, leaving no session id to cancel the turn with.
	const continuing = input.sessionId;
	const sessionId = continuing ?? (await createEveSession(target, body));
	const delivery: EveDelivery = continuing
		? await continueEveSession(target, continuing, body, input.cursor)
		: { startIndex: 0 };
	let position = delivery.startIndex;
	let turnId: string | undefined;
	let ownsCancellation = false;
	const observe = (event: EveEvent): void => {
		const id = (event.data as { turnId?: unknown } | undefined)?.turnId;
		if (turnId === undefined && typeof id === "string" && id) {
			turnId = id;
			// Rapid follow-ups can share one replacement turn. Only the latest
			// delivery may cancel it when its response disconnects.
			ownsCancellation = delivery.deliveryId === undefined ||
				event.meta?.deliveryIds?.at(-1) === delivery.deliveryId;
		}
	};
	let cancellation: Promise<void> | undefined;
	const cancel = (): Promise<void> => cancellation ??= (async () => {
		// One deadline covers discovery, retries, and the cancellation request.
		const signal = AbortSignal.timeout(10_000);
		// A disconnect can precede the first event (or even stream attachment).
		// Resolve ownership from the accepted delivery, never from "current turn".
		if (!turnId) {
			const pending = await openEveStream({
				target, sessionId, ...delivery, signal,
			});
			const reader = pending.getReader();
			try {
				while (!turnId) {
					const next = await reader.read();
					if (next.done) break;
					observe(next.value);
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
		}
		if (turnId && ownsCancellation) await cancelEveTurn(target, sessionId, turnId, signal);
	})();

	if (input.signal?.aborted) {
		await cancel().catch(() => {});
		throw input.signal.reason;
	}

	// Returned before the stream is attached, so a caller can answer as soon as
	// the runtime has accepted the turn.
	let reader: ReadableStreamDefaultReader<EveEvent> | undefined;
	const attachment = new AbortController();
	const events = new ReadableStream<EveEvent>({
		async pull(controller) {
			try {
				reader ??= (
					await openEveStream({
						target,
						sessionId,
						...delivery,
						onEvent: observe,
						onPosition: (next) => {
							position = next;
						},
						signal: input.signal
							? AbortSignal.any([input.signal, attachment.signal])
							: attachment.signal,
					})
				).getReader();
			} catch (error) {
				if (attachment.signal.aborted) return;
				await cancel().catch(() => {});
				controller.error(error);
				return;
			}
			if (attachment.signal.aborted) {
				await reader.cancel(attachment.signal.reason).catch(() => {});
				return;
			}
			try {
				const next = await reader.read();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			attachment.abort(reason);
			return reader?.cancel(reason);
		},
	});
	return {
		sessionId,
		chunks: events.pipeThrough(uiMessageChunks()),
		cancel,
		cursor: () => position,
	};
}

export async function cancelTurn(input: {
	eveUrl: string;
	credential: Credential;
	sessionId: string;
}): Promise<void> {
	await cancelEveTurn(
		{ eveUrl: input.eveUrl, credential: input.credential },
		input.sessionId,
	);
}

export async function runtimeHealth(input: {
	eveUrl: string;
	credential: Credential;
}): Promise<unknown> {
	return await eveHealth(input);
}

/** Frames the chunks as server-sent events, the way the SDK's embed reads them. */
export function encodeSse(
	chunks: ReadableStream<UIMessageChunk>,
): ReadableStream<Uint8Array> {
	const reader = chunks.getReader();
	const encoder = new TextEncoder();
	const frame = (value: unknown): Uint8Array =>
		encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
	let ended = false;

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (ended) {
				controller.close();
				return;
			}
			try {
				const next = await reader.read();
				if (!next.done) {
					controller.enqueue(frame(next.value));
					return;
				}
			} catch (error) {
				// A turn's own failure arrives as an `error` chunk; this is the transport
				// giving out, and the browser still needs a stream that terminates.
				controller.enqueue(
					frame({
						type: "error",
						errorText:
							error instanceof Error
								? error.message
								: "The agent stream failed.",
					}),
				);
				controller.enqueue(frame({ type: "finish", finishReason: "error" }));
			}
			ended = true;
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
		cancel(reason) {
			void reader.cancel(reason).catch(() => {});
		},
	});
}
