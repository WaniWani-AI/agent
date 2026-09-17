/**
 * The three spellings hosts use to bind a tool to a view. A server puts them on
 * the tool definition; the chat embed reads them off the tool result, because
 * it never lists tools itself. Copying them across at the call is what lets a
 * widget render off the platform.
 */
const VIEW_KEYS = ["ui", "ui/resourceUri", "openai/outputTemplate"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bindsView(meta: Record<string, unknown> | undefined): boolean {
	if (!meta) return false;
	const ui = meta.ui;
	return (
		(isRecord(ui) && typeof ui.resourceUri === "string" && ui.resourceUri.length > 0) ||
		(typeof meta["ui/resourceUri"] === "string" && meta["ui/resourceUri"].length > 0) ||
		(typeof meta["openai/outputTemplate"] === "string" &&
			meta["openai/outputTemplate"].length > 0)
	);
}

export function withViewBinding(
	result: unknown,
	definitionMeta: Record<string, unknown> | undefined,
): unknown {
	if (!isRecord(result) || !bindsView(definitionMeta)) return result;
	const existing = isRecord(result._meta) ? result._meta : {};
	if (bindsView(existing)) return result;
	const binding: Record<string, unknown> = {};
	for (const key of VIEW_KEYS) {
		if (definitionMeta?.[key] !== undefined) binding[key] = definitionMeta[key];
	}
	return { ...result, _meta: { ...existing, ...binding } };
}
