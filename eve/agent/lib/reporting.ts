import { serviceRequest } from "./tenant.js";

export type ReportEvent =
	| {
			kind: "user_message";
			eventId: string;
			occurredAt: string;
			turnId: string;
			text: string;
			id?: number;
	  }
	| { kind: "assistant_message"; eventId: string; occurredAt: string; turnId: string; text: string }
	| { kind: "guardrail_blocked"; eventId: string; occurredAt: string; turnId: string }
	| {
			kind: "usage";
			eventId: string;
			occurredAt: string;
			turnId: string;
			steps: UsageStep[];
	  }
	| { kind: "error"; eventId: string; occurredAt: string; turnId: string; message: string };

export type UsageStep = {
	modelId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	costUsd?: number;
	generationId?: string;
};

type Session = { environmentId: string; sessionId: string };

const DELIVERY_WINDOW_MS = 30_000;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;
/**
 * Well past the app's own bound on a report (redaction gives up at 2 s), so a
 * retry never races a first attempt the app is still storing: the app places
 * rows when a report arrives, and the retry would take a later place.
 */
const REQUEST_TIMEOUT_MS = 15_000;
const RESERVE_TIMEOUT_MS = 1_000;

/** One chain per session keeps the app's insert order equal to stream order. */
const chains = new Map<string, Promise<void>>();

function key(session: Session): string {
	return `${session.environmentId}\u0000${session.sessionId}`;
}

async function post(
	session: Session,
	body: Record<string, unknown>,
	timeoutMs: number,
): Promise<Response> {
	const { url, authorization } = serviceRequest({
		environmentId: session.environmentId,
		path: "/api/mcp/agent/events",
	});
	return await fetch(url, {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify({ sessionId: session.sessionId, ...body }),
		signal: AbortSignal.timeout(timeoutMs),
	});
}

export function report(session: Session, events: ReportEvent[]): Promise<boolean> {
	if (events.length === 0) return Promise.resolve(true);
	const previous = chains.get(key(session)) ?? Promise.resolve();
	const delivered = previous.then(() => deliver(session, events));
	const settled = delivered.then(
		() => undefined,
		() => undefined,
	);
	chains.set(key(session), settled);
	void settled.then(() => {
		if (chains.get(key(session)) === settled) chains.delete(key(session));
	});
	return delivered;
}

/** The app deduplicates on each event id, so a retry after a lost response writes nothing twice. */
async function deliver(session: Session, events: ReportEvent[]): Promise<boolean> {
	const deadline = Date.now() + DELIVERY_WINDOW_MS;
	let delay = BASE_DELAY_MS;
	for (let attempt = 1; ; attempt += 1) {
		let failure: string;
		try {
			const response = await post(
				session,
				{ events },
				Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())),
			);
			if (response.ok) return true;
			if (response.status < 500 && response.status !== 429) {
				console.error("[reporting] the app refused a report", {
					sessionId: session.sessionId,
					status: response.status,
				});
				return false;
			}
			failure = `status ${response.status}`;
		} catch (error) {
			failure = error instanceof Error ? error.message : "unknown";
		}
		if (Date.now() + delay >= deadline) {
			console.error("[reporting] delivery failed", {
				sessionId: session.sessionId,
				attempts: attempt,
				eventIds: events.map((event) => event.eventId),
				message: failure,
			});
			return false;
		}
		await new Promise((resolve) => setTimeout(resolve, delay));
		delay = Math.min(delay * 2, MAX_DELAY_MS);
	}
}

/**
 * The user row's place in the event order, taken before the turn starts, so the
 * row sorts ahead of everything the turn's tools report however late it lands.
 */
export async function reserveUserRow(session: Session): Promise<number | undefined> {
	try {
		const response = await post(session, { reserve: true }, RESERVE_TIMEOUT_MS);
		if (!response.ok) return undefined;
		const body: unknown = await response.json();
		const id =
			typeof body === "object" &&
			body !== null &&
			"data" in body &&
			typeof body.data === "object" &&
			body.data !== null &&
			"id" in body.data
				? body.data.id
				: undefined;
		return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}
