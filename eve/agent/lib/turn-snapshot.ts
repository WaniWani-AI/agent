import type { SessionAuth } from "eve/context";
import { cacheState, type Published, publishedNow } from "./published.js";
import { assertCallerOwnsSession, tenantOf } from "./tenant.js";
import { timing } from "./turn-timing.js";

const snapshots = new Map<string, Published>();

export function holdSnapshot(sessionId: string, published: Published): void {
	snapshots.set(sessionId, published);
}

/** Whatever the turn already holds, never a fetch: analytics must not depend on the network. */
export function heldSnapshot(sessionId: string): Published | undefined {
	return snapshots.get(sessionId);
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
	const tenant = tenantOf(input.auth);
	const cache = cacheState(tenant);
	const startedAt = Date.now();
	const rebuilt = await publishedNow(tenant);
	timing("snapshot.rebuilt", { sessionId: input.sessionId, cache, ms: Date.now() - startedAt });
	holdSnapshot(input.sessionId, rebuilt);
	return rebuilt;
}
