import type { SessionAuth } from "eve/context";
import { defineHook } from "eve/hooks";
import { isNativeSession } from "../lib/browser-token.js";
import { GUARDRAIL_BLOCKED } from "../lib/guardrail.js";
import { report } from "../lib/reporting.js";
import { waitUntil } from "../lib/wait-until.js";

type Meta = { meta: { id: string; at: string } };
type Ctx = { session: { id: string; auth: SessionAuth } };

const stepModels = new Map<string, string>();

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

function endTurn(input: { ctx: Ctx; event: Meta; turnId: string; error?: string }): void {
	stepModels.delete(input.ctx.session.id);
	const session = sessionOf(input.ctx);
	if (!session || input.error === undefined) return;
	waitUntil(
		report(session, [
			{
				kind: "error",
				eventId: eventId(input.event),
				occurredAt: input.event.meta.at,
				turnId: input.turnId,
				message: input.error,
			},
		]),
	);
}

function reservedId(ctx: Ctx): number | undefined {
	const id = Number(ctx.session.auth.current?.attributes.userEventId);
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Nothing here is awaited on the way to the model. Order does not depend on
 * delivery either: the channel reserved the user row's place before the turn.
 */
export default defineHook({
	events: {
		"message.received": (event, ctx) => {
			const session = sessionOf(ctx);
			if (!session || event.data.kind === "execution.background_task") return;
			const { turnId } = event.data;
			const id = reservedId(ctx);
			waitUntil(report(session, [
				{
					kind: "user_message",
					eventId: eventId(event),
					occurredAt: event.meta.at,
					turnId,
					text: event.data.message,
					...(id !== undefined ? { id } : {}),
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
			const session = sessionOf(ctx);
			const usage = event.data.usage;
			if (!session || !usage) return;
			// One row per model call: a turn's calls can run on different workers.
			waitUntil(
				report(session, [
					{
						kind: "usage",
						eventId: eventId(event),
						occurredAt: event.meta.at,
						turnId: event.data.turnId,
						steps: [
							{
								modelId: stepModels.get(ctx.session.id) ?? "unknown",
								inputTokens: usage.inputTokens ?? 0,
								outputTokens: usage.outputTokens ?? 0,
								cacheReadTokens: usage.cacheReadTokens ?? 0,
								...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
								...(event.data.providerMetadata?.gateway.generationId
									? { generationId: event.data.providerMetadata.gateway.generationId }
									: {}),
							},
						],
					},
				]),
			);
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
