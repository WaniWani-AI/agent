import { defineHook } from "eve/hooks";
import { resolveModelAccess } from "../lib/model.js";
import { publishedNow } from "../lib/published.js";
import { tenantOf } from "../lib/tenant.js";
import { holdSnapshot, releaseSnapshot } from "../lib/turn-snapshot.js";

/**
 * The gate: eve runs hooks before every resolver, and a throw here reaches the
 * caller as a recoverable `turn.failed`. Everything downstream reads the
 * snapshot it leaves behind.
 */
export default defineHook({
	events: {
		async "turn.started"(_event, ctx) {
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
