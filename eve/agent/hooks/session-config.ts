import { defineHook } from "eve/hooks";
import { resolveModelAccess } from "../lib/model.js";
import { publishedNow } from "../lib/published.js";
import { assertCallerOwnsSession, tenantOf } from "../lib/tenant.js";
import { holdSnapshot, releaseSnapshot } from "../lib/turn-snapshot.js";

/**
 * The gate: eve runs hooks before every resolver, so everything downstream reads
 * the snapshot this leaves behind. eve only logs a throw from a hook, so a turn
 * that fails here holds no snapshot, and the resolvers that rebuild it through
 * the same checks fail the turn.
 */
export default defineHook({
	events: {
		async "turn.started"(_event, ctx) {
			assertCallerOwnsSession(ctx.session.auth);
			const published = await publishedNow(tenantOf(ctx.session.auth));
			resolveModelAccess(published.config.model);
			holdSnapshot(ctx.session.id, published);
		},
		"turn.completed"(_event, ctx) {
			releaseSnapshot(ctx.session.id);
		},
		"turn.failed"(_event, ctx) {
			releaseSnapshot(ctx.session.id);
		},
		"turn.cancelled"(_event, ctx) {
			releaseSnapshot(ctx.session.id);
		},
	},
});
