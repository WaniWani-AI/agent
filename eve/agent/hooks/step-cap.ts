import { defineHook } from "eve/hooks";

/** The app loop's `AGENT_STEPS_PER_TURN`: both loops stop a turn after the same number of model calls. */
const MODEL_STEPS_PER_TURN = 10;

/**
 * eve has no per-turn step limit, only a session token budget, so a model that keeps
 * calling tools runs until that budget is spent. `stepIndex` restarts at 0 each turn,
 * and a cancel from `step.started` lands before that model call.
 */
export default defineHook({
	events: {
		"step.started"(event, ctx) {
			if (event.data.stepIndex < MODEL_STEPS_PER_TURN) return;
			console.warn("cancelling turn: model step cap reached", {
				sessionId: ctx.session.id,
				turnId: event.data.turnId,
				stepIndex: event.data.stepIndex,
				cap: MODEL_STEPS_PER_TURN,
			});
			ctx.cancel();
		},
	},
});
