import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import hook from "./step-cap.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stepStartedHandler(): Handler {
	const events: unknown = Reflect.get(hook, "events");
	const handler: unknown = isRecord(events) ? events["step.started"] : undefined;
	if (typeof handler !== "function") throw new Error("the step-cap hook has no step.started handler");
	return (event, ctx) => Reflect.apply(handler, undefined, [event, ctx]);
}

function stepStarted(turnId: string, stepIndex: number) {
	return {
		type: "step.started",
		meta: { id: `ev_${turnId}_${stepIndex}`, at: "2026-11-08T10:00:00.000Z" },
		data: { modelId: "openai/gpt-5-mini", sequence: stepIndex, stepIndex, turnId },
	};
}

let cancels = 0;
const ctx = {
	session: { id: "sess_step_cap" },
	cancel: () => {
		cancels += 1;
	},
};
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
	cancels = 0;
	warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
});

async function start(turnId: string, stepIndex: number): Promise<void> {
	await stepStartedHandler()(stepStarted(turnId, stepIndex), ctx);
}

describe("step.started", () => {
	test("the first model call of a turn runs", async () => {
		await start("turn_a", 0);
		expect(cancels).toBe(0);
	});

	test("the tenth model call (stepIndex 9) runs", async () => {
		await start("turn_a", 9);
		expect(cancels).toBe(0);
	});

	test("the eleventh model call (stepIndex 10) is cancelled once", async () => {
		await start("turn_a", 10);
		expect(cancels).toBe(1);
	});

	test("a far larger stepIndex is cancelled once", async () => {
		await start("turn_a", 500);
		expect(cancels).toBe(1);
	});

	test("a full turn of steps 0..9 never cancels, and step 10 cancels exactly once", async () => {
		for (let index = 0; index <= 9; index += 1) await start("turn_full", index);
		expect(cancels).toBe(0);
		await start("turn_full", 10);
		expect(cancels).toBe(1);
	});

	test("each offending call cancels again", async () => {
		await start("turn_a", 10);
		await start("turn_a", 11);
		expect(cancels).toBe(2);
	});

	test("a new turn starting again at stepIndex 0 is not cancelled after a capped turn", async () => {
		await start("turn_capped", 10);
		expect(cancels).toBe(1);
		for (let index = 0; index <= 9; index += 1) await start("turn_next", index);
		expect(cancels).toBe(1);
	});
});
