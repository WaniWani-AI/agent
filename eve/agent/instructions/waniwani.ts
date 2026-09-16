import { defineDynamic, defineInstructions } from "eve/instructions";
import { snapshotFor } from "../lib/turn-snapshot.js";

export default defineDynamic({
	events: {
		"turn.started": async (_event, ctx) => {
			const { config } = await snapshotFor({
				sessionId: ctx.session.id,
				auth: ctx.session.auth,
			});
			return defineInstructions({ content: config.instructions });
		},
	},
});
