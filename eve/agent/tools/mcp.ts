import { defineDynamic, defineTool } from "eve/tools";
import type { JsonObject } from "../lib/json.js";
import { callMcpTool, type McpMeta } from "../lib/mcp-catalog.js";
import { toolModelOutput } from "../lib/tool-output.js";
import { ANONYMOUS, resolveChannel, tenantOf } from "../lib/tenant.js";
import { snapshotFor } from "../lib/turn-snapshot.js";
import type { SessionChannel } from "../lib/session-config.js";
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

function parsedExtra(raw: unknown): Record<string, unknown> | undefined {
	if (typeof raw !== "string") return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

/**
 * eve hands a tool resolver an empty `messages` array at `turn.started`, so the
 * turn sequence is what counts this conversation's user messages.
 */
function turnCountOf(event: unknown): number {
	const sequence = (event as { data?: { sequence?: unknown } })?.data?.sequence;
	return typeof sequence === "number" ? sequence + 1 : 1;
}

/** The same keys the app's `buildMcpMeta` produces, so an MCP server reads one shape. */
function buildMeta(input: {
	ctx: DynamicResolveContext;
	channels: SessionChannel[];
	turnCount: number;
}): McpMeta {
	const { auth } = input.ctx.session;
	const visitorId = auth.initiator?.subject;
	const channel = resolveChannel({ auth, channels: input.channels });
	const extra = parsedExtra(auth.current?.attributes.extra);

	return {
		...(extra ? { "waniwani/extra": extra } : {}),
		"waniwani/sessionId": input.ctx.session.id,
		...(visitorId && visitorId !== ANONYMOUS
			? { "waniwani/visitorId": visitorId }
			: {}),
		"waniwani/turnCount": input.turnCount,
		...(channel ? { "waniwani/channelId": channel.id } : {}),
		...(channel?.label ? { "waniwani/source": channel.label } : {}),
	};
}

export default defineDynamic({
	events: {
		"turn.started": async (event, ctx) => {
			const { config, tools } = await snapshotFor({
				sessionId: ctx.session.id,
				auth: ctx.session.auth,
			});
			// Narrow what the durable tool callback closes over: `config` also
			// carries the model, and a BYO model may carry a key.
			const { mcpUrl } = config;
			const sessionId = ctx.session.id;
			const tenantKey = tenantOf(ctx.session.auth).key;
			const meta = buildMeta({
				ctx,
				channels: config.channels,
				turnCount: turnCountOf(event),
			});

			return Object.fromEntries(
				tools.map((tool) => {
					const wantsSessionId = declaresSessionId(tool.inputSchema);
					return [
						tool.name,
						defineTool({
							description: tool.description ?? tool.name,
							inputSchema: withoutSessionId(tool.inputSchema),
							execute: (input: Record<string, unknown>, toolCtx) =>
								callMcpTool({
									tenantKey,
									mcpUrl,
									name: tool.name,
									arguments: wantsSessionId ? { ...input, sessionId } : input,
									meta,
									abortSignal: toolCtx.abortSignal,
								}),
							toModelOutput: (output: unknown) => toolModelOutput(output),
						}),
					];
				}),
			);
		},
	},
});
