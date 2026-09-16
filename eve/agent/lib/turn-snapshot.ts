import type { Published } from "./published.js";

const snapshots = new Map<string, Published>();

export function holdSnapshot(sessionId: string, published: Published): void {
	snapshots.set(sessionId, published);
}

export function releaseSnapshot(sessionId: string): void {
	snapshots.delete(sessionId);
}

export function requireSnapshot(sessionId: string): Published {
	const snapshot = snapshots.get(sessionId);
	if (!snapshot) {
		throw new Error(
			"This turn has no published configuration snapshot; the turn.started gate did not run",
		);
	}
	return snapshot;
}
