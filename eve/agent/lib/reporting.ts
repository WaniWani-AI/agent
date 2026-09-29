import { serviceRequest } from "./tenant.js";

export type ReportEvent =
	| { kind: "user_message"; eventId: string; occurredAt: string; turnId: string; text: string }
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

const ATTEMPTS = 4;
const BASE_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 5_000;

/** One chain per session keeps the app's insert order equal to stream order. */
const chains = new Map<string, Promise<void>>();

const userRows = new Map<string, Promise<boolean>>();

function key(session: Session, turnId?: string): string {
	return `${session.environmentId}\u0000${session.sessionId}${turnId ? `\u0000${turnId}` : ""}`;
}

async function post(session: Session, body: Record<string, unknown>): Promise<Response> {
	const { url, authorization } = serviceRequest({
		environmentId: session.environmentId,
		path: "/api/mcp/agent/events",
	});
	return await fetch(url, {
		method: "POST",
		headers: { authorization, "content-type": "application/json" },
		body: JSON.stringify({ sessionId: session.sessionId, ...body }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
}

/** The app deduplicates on each event id, so a retry after a lost response writes nothing twice. */
async function deliver(session: Session, events: ReportEvent[]): Promise<boolean> {
	let delay = BASE_DELAY_MS;
	for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
		try {
			const response = await post(session, { events });
			if (response.ok) return true;
			if (response.status < 500 && response.status !== 429) {
				console.error("[reporting] the app refused a report", {
					sessionId: session.sessionId,
					status: response.status,
				});
				return false;
			}
		} catch (error) {
			if (attempt === ATTEMPTS) {
				console.error("[reporting] delivery failed", {
					sessionId: session.sessionId,
					message: error instanceof Error ? error.message : "unknown",
				});
			}
		}
		if (attempt < ATTEMPTS) {
			await new Promise((resolve) => setTimeout(resolve, delay));
			delay *= 3;
		}
	}
	return false;
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
	for (const event of events) {
		if (event.kind === "user_message") userRows.set(key(session, event.turnId), delivered);
	}
	return delivered;
}

/** Called once a turn ends: nothing of that turn waits on its user row any more. */
export function forgetTurn(session: Session & { turnId: string }): void {
	userRows.delete(key(session, session.turnId));
}

/** Customer tools report their own analytics and enrichment replays in insert order, so a tool waits for its turn's user row. */
export async function userRowStored(session: Session & { turnId: string }): Promise<boolean> {
	const local = userRows.get(key(session, session.turnId));
	if (local) return await local.catch(() => false);
	try {
		const response = await post(session, { barrier: { turnId: session.turnId } });
		if (!response.ok) return false;
		const body: unknown = await response.json();
		return (
			typeof body === "object" &&
			body !== null &&
			"data" in body &&
			typeof body.data === "object" &&
			body.data !== null &&
			"stored" in body.data &&
			body.data.stored === true
		);
	} catch {
		return false;
	}
}
