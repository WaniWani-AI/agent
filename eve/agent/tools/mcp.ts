import { defineDynamic, defineTool } from "eve/tools";
import type { JsonObject } from "../lib/json.js";
import { callMcpTool, type McpMeta } from "../lib/mcp-catalog.js";
import { mcpMeta } from "../lib/mcp-meta.js";
import { toolModelOutput } from "../lib/tool-output.js";
import { withViewBinding } from "../lib/view-binding.js";
import { resolveChannel, tenantOf } from "../lib/tenant.js";
import { snapshotFor } from "../lib/turn-snapshot.js";
import type { SessionChannel } from "../lib/session-config.js";
import { isNativeSession } from "../lib/browser-token.js";
import { GUARDRAIL_BLOCKED } from "../lib/guardrail.js";
import { userRowStored } from "../lib/reporting.js";
import type { DynamicResolveContext } from "eve/tools";

function declaresSessionId(schema: JsonObject): boolean {
	const properties = schema.properties;
	return (
		typeof properties === "object" &&
		properties !== null &&
		!Array.isArray(properties) &&
		"sessionId" in properties
	);
}

// Session identity belongs to the runtime, never to the model, so it comes off
// the model-facing schema here and goes back on at the call.
function withoutSessionId(schema: JsonObject): JsonObject {
	const properties = schema.properties;
	const required = schema.required;
	return {
		...schema,
		...(properties &&
		typeof properties === "object" &&
		!Array.isArray(properties)
			? {
					properties: Object.fromEntries(
						Object.entries(properties).filter(([key]) => key !== "sessionId"),
					),
				}
			: {}),
		...(Array.isArray(required)
			? { required: required.filter((key) => key !== "sessionId") }
			: {}),
	};
}

function turnIdOf(event: unknown): string | undefined {
	const turnId = (event as { data?: { turnId?: unknown } })?.data?.turnId;
	return typeof turnId === "string" ? turnId : undefined;
}

function turnCountOf(event: unknown): number {
	const sequence = (event as { data?: { sequence?: unknown } })?.data?.sequence;
	return typeof sequence === "number" ? sequence + 1 : 1;
}

function buildMeta(input: {
	ctx: DynamicResolveContext;
	channels: SessionChannel[];
	turnCount: number;
}): McpMeta {
	const { auth } = input.ctx.session;
	return mcpMeta({
		sessionId: input.ctx.session.id,
		visitorId: auth.initiator?.subject,
		turnCount: input.turnCount,
		channel: resolveChannel({ auth, channels: input.channels }),
		extraHeader: auth.current?.attributes.extra,
		contextHeader: auth.current?.attributes.context,
	});
}

export default defineDynamic({
	events: {
		"turn.started": async (event, ctx) => {
			if (ctx.session.auth.current?.attributes.guardrail === GUARDRAIL_BLOCKED) return {};
			const { config, tools } = await snapshotFor({
				sessionId: ctx.session.id,
				auth: ctx.session.auth,
			});
			// Narrow what the durable tool callback closes over: `config` also
			// carries the model, and a BYO model may carry a key.
			const { mcpUrl } = config;
			const sessionId = ctx.session.id;
			const tenant = tenantOf(ctx.session.auth);
			const tenantKey = tenant.key;
			const meta = buildMeta({
				ctx,
				channels: config.channels,
				turnCount: turnCountOf(event),
			});
			const turnId = turnIdOf(event);
			const barrier =
				isNativeSession(ctx.session.auth) && tenant.environmentId && turnId
					? { environmentId: tenant.environmentId, sessionId, turnId }
					: undefined;

			return Object.fromEntries(
				tools.map((tool) => {
					const wantsSessionId = declaresSessionId(tool.inputSchema);
					return [
						tool.name,
						defineTool({
							description: tool.description ?? tool.name,
							inputSchema: withoutSessionId(tool.inputSchema),
							execute: async (input: Record<string, unknown>, toolCtx) => {
								if (barrier && !(await userRowStored(barrier))) {
									console.error("[reporting] a tool ran before its turn's user row was stored", {
										sessionId,
										turnId: barrier.turnId,
									});
								}
								return withViewBinding(
									await callMcpTool({
										tenantKey,
										mcpUrl,
										name: tool.name,
										arguments: wantsSessionId ? { ...input, sessionId } : input,
										meta,
										abortSignal: toolCtx.abortSignal,
									}),
									tool.meta,
								);
							},
							toModelOutput: (output: unknown) => toolModelOutput(output),
						}),
					];
				}),
			);
		},
	},
});
