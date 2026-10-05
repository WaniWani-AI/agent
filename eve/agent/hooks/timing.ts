import { defineHook } from "eve/hooks";
import { timing } from "../lib/turn-timing.js";

type Event = { type: string; meta: { at: string }; data?: { turnId?: string } };
type Ctx = { session: { id: string } };

function mark(event: Event, ctx: Ctx): void {
	timing(event.type, {
		sessionId: ctx.session.id,
		turnId: event.data?.turnId,
		eventAt: Date.parse(event.meta.at),
	});
}

export default defineHook({
	events: {
		"message.received": mark,
		"turn.started": mark,
		"step.started": mark,
		"step.completed": mark,
		"turn.completed": mark,
		"turn.failed": mark,
	},
});
