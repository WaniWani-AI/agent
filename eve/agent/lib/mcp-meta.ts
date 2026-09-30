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

function jsonArray(raw: unknown): unknown[] | undefined {
	if (typeof raw !== "string") return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		return Array.isArray(value) && value.length > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

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
 * shape. The context header carries what only the app knows (a forwarded turn's
 * documents, channel metadata, user agent, geolocation). A browser's documents
 * arrive validated with its message. Identity and turn count stay the runtime's.
 */
export function mcpMeta(input: {
	sessionId: string;
	visitorId: string | undefined;
	turnCount: number;
	channel: ChannelSource | undefined;
	extraHeader: unknown;
	contextHeader: unknown;
	documentsHeader?: unknown;
}): McpMeta {
	const extra = jsonObject(input.extraHeader);
	const documents = jsonArray(input.documentsHeader);
	const context = Object.fromEntries(
		Object.entries(jsonObject(input.contextHeader) ?? {}).filter(
			([key]) => !DERIVED_KEYS.has(key),
		),
	);
	const { visitorId, channel } = input;

	return {
		...(extra ? { "waniwani/extra": extra } : {}),
		...context,
		...(documents ? { "waniwani/documents": documents } : {}),
		"waniwani/sessionId": input.sessionId,
		...(visitorId && visitorId !== ANONYMOUS
			? { "waniwani/visitorId": visitorId }
			: {}),
		"waniwani/turnCount": input.turnCount,
		...(channel ? { "waniwani/channelId": channel.id } : {}),
		"waniwani/source": channel?.label?.trim() || channel?.type || "unknown",
	};
}
