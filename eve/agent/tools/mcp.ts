import { defineDynamic, defineTool } from "eve/tools";
import type { JsonObject } from "../lib/json.js";
import { callMcpTool, type McpMeta, textOf } from "../lib/mcp-catalog.js";
import { ANONYMOUS, channelIdOf, tenantOf } from "../lib/tenant.js";
import { requireSnapshot } from "../lib/turn-snapshot.js";
import type { SessionChannel } from "../lib/session-config.js";
import type { DynamicResolveContext } from "eve/tools";

// Session identity belongs to the runtime, never to the model.
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
	const channelId = channelIdOf(auth) ?? input.channels[0]?.id;
	const channel = input.channels.find((entry) => entry.id === channelId);
	const extra = parsedExtra(auth.current?.attributes.extra);

	return {
		...(extra ? { "waniwani/extra": extra } : {}),
		"waniwani/sessionId": input.ctx.session.id,
		...(visitorId && visitorId !== ANONYMOUS
			? { "waniwani/visitorId": visitorId }
			: {}),
		"waniwani/turnCount": input.turnCount,
		...(channelId ? { "waniwani/channelId": channelId } : {}),
		...(channel?.label ? { "waniwani/source": channel.label } : {}),
	};
}

export default defineDynamic({
	events: {
		"turn.started": (event, ctx) => {
			const { config, tools } = requireSnapshot(ctx.session.id);
			const tenantKey = tenantOf(ctx.session.auth).key;
			const meta = buildMeta({
				ctx,
				channels: config.channels,
				turnCount: turnCountOf(event),
			});

			return Object.fromEntries(
				tools.map((tool) => [
					tool.name,
					defineTool({
						description: tool.description ?? tool.name,
						inputSchema: withoutSessionId(tool.inputSchema),
						execute: (input: Record<string, unknown>, toolCtx) =>
							callMcpTool({
								tenantKey,
								mcpUrl: config.mcpUrl,
								name: tool.name,
								arguments: input,
								meta,
								abortSignal: toolCtx.abortSignal,
							}),
						// The durable result keeps `_meta` for the adapter; the model sees text.
						toModelOutput: (output: unknown) => ({
							type: "text" as const,
							value: textOf(output),
						}),
					}),
				]),
			);
		},
	},
});
