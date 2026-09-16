import { waniwani } from "@waniwani/sdk";
import { defineHook } from "eve/hooks";
import type { SessionAuth } from "eve/context";
import { ANONYMOUS, resolveChannel } from "../lib/tenant.js";
import { heldSnapshot } from "../lib/turn-snapshot.js";

type StreamEvent = {
	meta: { id: string; at: string };
	data?: Record<string, unknown>;
};

/** Hooks are awaited before the turn's resolvers, so delivery cannot be unbounded. */
const DELIVERY_TIMEOUT_MS = 5_000;

let analytics: ReturnType<typeof waniwani> | undefined;

/** Model ids arrive on `step.started` and usage on `step.completed`, one step apart. */
const stepModels = new Map<string, string>();

let warnedMultiTenant = false;

/**
 * Ingestion resolves the destination environment from the public key, and this
 * runtime holds exactly one. A hosted runtime serves many environments, so
 * reporting them all through that key would file every tenant's transcript
 * under whoever owns it.
 */
function enabled(): boolean {
	if (
		process.env.WANIWANI_ANALYTICS !== "ingest" ||
		!process.env.WANIWANI_PUBLIC_KEY
	) {
		return false;
	}
	if (process.env.WANIWANI_SERVICE_PRIVATE_KEY) {
		if (!warnedMultiTenant) {
			warnedMultiTenant = true;
			console.error(
				"[analytics] disabled: WANIWANI_PUBLIC_KEY names one environment and this runtime serves many",
			);
		}
		return false;
	}
	return true;
}

function turnIdOf(event: StreamEvent): string | undefined {
	const turnId = event.data?.turnId;
	return typeof turnId === "string" ? turnId : undefined;
}

function channelIdOf(sessionId: string, auth: SessionAuth): string | undefined {
	const channels = heldSnapshot(sessionId)?.config.channels;
	if (!channels) return undefined;
	try {
		return resolveChannel({ auth, channels })?.id;
	} catch {
		return undefined;
	}
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

type Ctx = { session: { id: string; auth: SessionAuth } };

async function send(
	name: string,
	event: StreamEvent,
	ctx: Ctx,
	properties: Record<string, unknown> = {},
): Promise<void> {
	const apiKey = process.env.WANIWANI_PUBLIC_KEY;
	if (!enabled() || !apiKey) {
		return;
	}
	const { id, auth } = ctx.session;
	try {
		analytics ??= waniwani({ apiKey, apiUrl: process.env.WANIWANI_API_URL });
		await withDeadline(
			deliver({
				event: name,
				eventId: `eve_${event.meta.id}`,
				timestamp: event.meta.at,
				sessionId: id,
				visitorId: visitorIdOf(auth),
				properties: { ...properties, channelId: channelIdOf(id, auth) },
				metadata: { turnId: turnIdOf(event) },
				// The ingestion API takes chat events; the SDK's public union omits them.
			} as Parameters<typeof analytics.track>[0]),
		);
	} catch (error) {
		console.error("[analytics] delivery failed", {
			event: name,
			message: error instanceof Error ? error.message : "unknown",
		});
	}
}

export default defineHook({
	events: {
		"session.started": (event, ctx) => send("session.started", event, ctx),
		"message.received": (event, ctx) =>
			send("chat.user_message", event, ctx, { text: event.data.message }),
		"message.completed": (event, ctx) =>
			event.data.message
				? send("chat.assistant_message", event, ctx, {
						text: event.data.message,
					})
				: undefined,
		"action.result": (event, ctx) => {
			const result = event.data.result;
			if (result.kind !== "tool-result") {
				return;
			}
			return send("tool.called", event, ctx, {
				name: result.toolName,
				output: result.output,
				isError: result.isError ?? false,
				callId: result.callId,
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
			return send("chat.usage", event, ctx, {
				model: modelId,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cacheReadTokens,
				totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
				costUsd: usage.costUsd,
				steps: [{ modelId, ...usage }],
				granularity: "step",
			});
		},
		"turn.failed": (event, ctx) => {
			stepModels.delete(ctx.session.id);
			return send("session.error", event, ctx, {
				code: "agent_failed",
				message: event.data.message,
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
