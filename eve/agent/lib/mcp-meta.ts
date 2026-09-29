import type { McpMeta } from "./mcp-catalog.js";
import { ANONYMOUS, type ChannelSource } from "./tenant.js";

/** Keys the runtime derives or owns, which a caller's context header never sets. */
const DERIVED_KEYS = new Set([
	"waniwani/extra",
	"waniwani/sessionId",
	"waniwani/visitorId",
	"waniwani/turnCount",
	"waniwani/channelId",
	"waniwani/source",
]);

function jsonObject(raw: unknown): Record<string, unknown> | undefined {
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
 * The same keys the app's `buildMcpMeta` produces, so an MCP server reads one
 * shape. The context header carries what only the app knows (documents, channel
 * metadata, user agent, geolocation); identity and turn count stay the runtime's.
 */
export function mcpMeta(input: {
	sessionId: string;
	visitorId: string | undefined;
	turnCount: number;
	channel: ChannelSource | undefined;
	extraHeader: unknown;
	contextHeader: unknown;
}): McpMeta {
	const extra = jsonObject(input.extraHeader);
	const context = Object.fromEntries(
		Object.entries(jsonObject(input.contextHeader) ?? {}).filter(
			([key]) => !DERIVED_KEYS.has(key),
		),
	);
	const { visitorId, channel } = input;

	return {
		...(extra ? { "waniwani/extra": extra } : {}),
		...context,
		"waniwani/sessionId": input.sessionId,
		...(visitorId && visitorId !== ANONYMOUS
			? { "waniwani/visitorId": visitorId }
			: {}),
		"waniwani/turnCount": input.turnCount,
		...(channel ? { "waniwani/channelId": channel.id } : {}),
		"waniwani/source": channel?.label?.trim() || channel?.type || "unknown",
	};
}
