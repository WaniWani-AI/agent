import type { SessionAuth } from "eve/context";
import { type Published, publishedNow } from "./published.js";
import { assertCallerOwnsSession, tenantOf } from "./tenant.js";

const snapshots = new Map<string, Published>();

export function holdSnapshot(sessionId: string, published: Published): void {
	snapshots.set(sessionId, published);
}

export function releaseSnapshot(sessionId: string): void {
	snapshots.delete(sessionId);
}

/**
 * eve does not re-emit `turn.started` for a turn it resumes after a restart, so
 * the gate never runs again and this map is empty. Rebuilding beats failing a
 * conversation that eve is willing to carry on.
 */
export async function snapshotFor(input: {
	sessionId: string;
	auth: SessionAuth;
}): Promise<Published> {
	const held = snapshots.get(input.sessionId);
	if (held) {
		return held;
	}
	assertCallerOwnsSession(input.auth);
	const rebuilt = await publishedNow(tenantOf(input.auth));
	holdSnapshot(input.sessionId, rebuilt);
	return rebuilt;
}
