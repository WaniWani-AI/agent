import { waniwani } from "@waniwani/sdk";
import { defineHook } from "eve/hooks";
import type { SessionAuth } from "eve/context";
import { ANONYMOUS, channelIdOf } from "../lib/tenant.js";

type StreamEvent = {
	meta: { id: string; at: string };
	data?: Record<string, unknown>;
};

/** Hooks are awaited before the turn's resolvers, so delivery cannot be unbounded. */
const DELIVERY_TIMEOUT_MS = 5_000;

let analytics: ReturnType<typeof waniwani> | undefined;

/** Model ids arrive on `step.started` and usage on `step.completed`, one step apart. */
const stepModels = new Map<string, string>();

function enabled(): boolean {
	return (
		process.env.WANIWANI_ANALYTICS === "ingest" &&
		Boolean(process.env.WANIWANI_PUBLIC_KEY)
	);
}

function turnIdOf(event: StreamEvent): string | undefined {
	const turnId = event.data?.turnId;
	return typeof turnId === "string" ? turnId : undefined;
}

function visitorIdOf(auth: SessionAuth): string | undefined {
	const subject = auth.initiator?.subject;
	return subject && subject !== ANONYMOUS ? subject : undefined;
}

async function deliver(
	event: Parameters<NonNullable<typeof analytics>["track"]>[0],
): Promise<void> {
	if (!analytics) return;
	await analytics.track(event);
	await analytics.flush();
}

async function withDeadline(delivery: Promise<void>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			delivery,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("delivery timed out")),
					DELIVERY_TIMEOUT_MS,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		// The abandoned delivery keeps running; it must not surface unhandled.
		void delivery.catch(() => {});
	}
}

async function send(input: {
	name: string;
	event: StreamEvent;
	sessionId: string;
	auth: SessionAuth;
	properties: Record<string, unknown>;
}): Promise<void> {
	const apiKey = process.env.WANIWANI_PUBLIC_KEY;
	if (!enabled() || !apiKey) {
		return;
	}
	try {
		analytics ??= waniwani({ apiKey, apiUrl: process.env.WANIWANI_API_URL });
		await withDeadline(deliver({
			event: input.name,
			eventId: `eve_${input.event.meta.id}`,
			timestamp: input.event.meta.at,
			sessionId: input.sessionId,
			visitorId: visitorIdOf(input.auth),
			properties: {
				...input.properties,
				channelId: channelIdOf(input.auth),
			},
			metadata: { turnId: turnIdOf(input.event) },
			// The ingestion API takes chat events; the SDK's public union omits them.
		} as Parameters<typeof analytics.track>[0]));
	} catch (error) {
		console.error("[analytics] delivery failed", {
			event: input.name,
			message: error instanceof Error ? error.message : "unknown",
		});
	}
}

export default defineHook({
	events: {
		"session.started": (event, ctx) =>
			send({
				name: "session.started",
				event,
				sessionId: ctx.session.id,
				auth: ctx.session.auth,
				properties: {},
			}),
		"message.received": (event, ctx) =>
			send({
				name: "chat.user_message",
				event,
				sessionId: ctx.session.id,
				auth: ctx.session.auth,
				properties: { text: event.data.message },
			}),
		"message.completed": (event, ctx) =>
			event.data.message
				? send({
						name: "chat.assistant_message",
						event,
						sessionId: ctx.session.id,
						auth: ctx.session.auth,
						properties: { text: event.data.message },
					})
				: undefined,
		"action.result": (event, ctx) => {
			const result = event.data.result;
			if (result.kind !== "tool-result") {
				return;
			}
			return send({
				name: "tool.called",
				event,
				sessionId: ctx.session.id,
				auth: ctx.session.auth,
				properties: {
					name: result.toolName,
					output: result.output,
					isError: result.isError ?? false,
					callId: result.callId,
				},
			});
		},
		"step.started": (event, ctx) => {
			if (enabled()) stepModels.set(ctx.session.id, event.data.modelId);
		},
		"step.completed": (event, ctx) => {
			const usage = event.data.usage;
			if (!usage) {
				return;
			}
			const modelId = stepModels.get(ctx.session.id);
			return send({
				name: "chat.usage",
				event,
				sessionId: ctx.session.id,
				auth: ctx.session.auth,
				properties: {
					model: modelId,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cachedInputTokens: usage.cacheReadTokens,
					totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
					costUsd: usage.costUsd,
					steps: [{ modelId, ...usage }],
					granularity: "step",
				},
			});
		},
		"turn.failed": (event, ctx) => {
			stepModels.delete(ctx.session.id);
			return send({
				name: "session.error",
				event,
				sessionId: ctx.session.id,
				auth: ctx.session.auth,
				properties: { code: "agent_failed", message: event.data.message },
			});
		},
		"turn.completed": (_event, ctx) => {
			stepModels.delete(ctx.session.id);
		},
		"turn.cancelled": (_event, ctx) => {
			stepModels.delete(ctx.session.id);
		},
	},
});
