/**
 * The three spellings a server may use to bind a tool to a view. Skybridge
 * writes them on the tool definition; the chat embed reads them off the tool
 * result, because it never lists tools itself.
 */
const VIEW_KEYS = ["ui", "ui/resourceUri", "openai/outputTemplate"];

/** The result with the definition's view binding, for each key the result lacks. */
export function withViewBinding(
	result: unknown,
	definitionMeta: Record<string, unknown> = {},
): unknown {
	if (typeof result !== "object" || result === null) return result;
	const existing = (result as { _meta?: Record<string, unknown> })._meta ?? {};
	const missing = VIEW_KEYS.filter(
		(key) => existing[key] === undefined && definitionMeta[key] !== undefined,
	);
	if (missing.length === 0) return result;
	const binding = Object.fromEntries(missing.map((key) => [key, definitionMeta[key]]));
	return { ...result, _meta: { ...existing, ...binding } };
}
