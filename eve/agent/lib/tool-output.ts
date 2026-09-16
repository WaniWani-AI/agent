/**
 * What the model is allowed to see. `_meta` stays on the durable result for the
 * adapter, and a server that answers only in `structuredContent` still reaches
 * the model rather than handing it an empty string.
 */
export function toolModelOutput(
	result: unknown,
): { type: "text"; value: string } | { type: "json"; value: unknown } {
	const text = textOf(result);
	if (text) {
		return { type: "text", value: text };
	}
	const structured = (result as { structuredContent?: unknown })
		?.structuredContent;
	return structured === undefined
		? { type: "text", value: "" }
		: { type: "json", value: structured };
}

export function textOf(result: unknown): string {
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part: unknown): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}
