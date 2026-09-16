import { defineDynamic, defineInstructions } from "eve/instructions";
import { requireSnapshot } from "../lib/turn-snapshot.js";

export default defineDynamic({
	events: {
		"turn.started": (_event, ctx) => {
			const { config } = requireSnapshot(ctx.session.id);
			return defineInstructions({ content: config.instructions });
		},
	},
});
