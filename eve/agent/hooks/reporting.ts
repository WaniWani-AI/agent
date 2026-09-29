import type { SessionAuth } from "eve/context";
import { defineHook } from "eve/hooks";
import { isNativeSession } from "../lib/browser-token.js";
import { GUARDRAIL_BLOCKED } from "../lib/guardrail.js";
import { report, type UsageStep } from "../lib/reporting.js";
import { waitUntil } from "../lib/wait-until.js";

type Meta = { meta: { id: string; at: string } };
type Ctx = { session: { id: string; auth: SessionAuth } };

const stepModels = new Map<string, string>();
const turnUsage = new Map<string, UsageStep[]>();

function sessionOf(ctx: Ctx): { environmentId: string; sessionId: string } | undefined {
	if (!isNativeSession(ctx.session.auth)) return undefined;
	const environmentId = ctx.session.auth.initiator?.attributes.environmentId;
	return typeof environmentId === "string"
		? { environmentId, sessionId: ctx.session.id }
		: undefined;
}

function eventId(event: Meta): string {
	return `eve_${event.meta.id}`;
}

function endTurn(input: {
	ctx: Ctx;
	event: Meta;
	turnId: string;
	error?: string;
}): void {
	const session = sessionOf(input.ctx);
	const steps = turnUsage.get(input.ctx.session.id) ?? [];
	turnUsage.delete(input.ctx.session.id);
	stepModels.delete(input.ctx.session.id);
	if (!session) return;
	waitUntil(report(session, [
		...(steps.length > 0
			? [
					{
						kind: "usage" as const,
						eventId: `${eventId(input.event)}_usage`,
						occurredAt: input.event.meta.at,
						turnId: input.turnId,
						steps,
					},
				]
			: []),
		...(input.error !== undefined
			? [
					{
						kind: "error" as const,
						eventId: eventId(input.event),
						occurredAt: input.event.meta.at,
						turnId: input.turnId,
						message: input.error,
					},
				]
			: []),
	]));
}

/**
 * Nothing here is awaited on the way to the model: deliveries run on a
 * per-session chain, and the tool barrier is what waits for the user row.
 */
export default defineHook({
	events: {
		"message.received": (event, ctx) => {
			const session = sessionOf(ctx);
			if (!session || event.data.kind === "execution.background_task") return;
			const { turnId } = event.data;
			waitUntil(report(session, [
				{
					kind: "user_message",
					eventId: eventId(event),
					occurredAt: event.meta.at,
					turnId,
					text: event.data.message,
				},
				...(ctx.session.auth.current?.attributes.guardrail === GUARDRAIL_BLOCKED
					? [
							{
								kind: "guardrail_blocked" as const,
								eventId: `${eventId(event)}_guardrail`,
								occurredAt: event.meta.at,
								turnId,
							},
						]
					: []),
			]));
		},
		"message.completed": (event, ctx) => {
			const session = sessionOf(ctx);
			const text = event.data.message;
			if (!session || !text?.trim()) return;
			waitUntil(
				report(session, [
					{
						kind: "assistant_message",
						eventId: eventId(event),
						occurredAt: event.meta.at,
						turnId: event.data.turnId,
						text,
					},
				]),
			);
		},
		"step.started": (event, ctx) => {
			if (sessionOf(ctx)) stepModels.set(ctx.session.id, event.data.modelId);
		},
		"step.completed": (event, ctx) => {
			const usage = event.data.usage;
			if (!sessionOf(ctx) || !usage) return;
			const steps = turnUsage.get(ctx.session.id) ?? [];
			steps.push({
				modelId: stepModels.get(ctx.session.id) ?? "unknown",
				inputTokens: usage.inputTokens ?? 0,
				outputTokens: usage.outputTokens ?? 0,
				cacheReadTokens: usage.cacheReadTokens ?? 0,
				...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
				...(event.data.providerMetadata?.gateway.generationId
					? { generationId: event.data.providerMetadata.gateway.generationId }
					: {}),
			});
			turnUsage.set(ctx.session.id, steps);
		},
		"turn.completed": (event, ctx) => {
			endTurn({ ctx, event, turnId: event.data.turnId });
		},
		"turn.cancelled": (event, ctx) => {
			endTurn({ ctx, event, turnId: event.data.turnId });
		},
		"turn.failed": (event, ctx) => {
			endTurn({ ctx, event, turnId: event.data.turnId, error: event.data.message });
		},
	},
});
