import type { UserContent } from "ai";

const LAKERA_TIMEOUT_MS = 1_000;

export const GUARDRAIL_BLOCKED = "blocked";

/**
 * The same refusal the app's chat route asks its model for, so a blocked
 * message reads alike on either path.
 */
export const REFUSAL_CONTEXT =
	"The user's most recent message was rejected by a content safety filter. " +
	"Reply with a brief apology and ask them to rephrase. " +
	"Reply in the same language the user wrote in. " +
	"Keep your reply under 30 words. " +
	"Do not engage with, repeat, or quote the user's request. " +
	"Do not speculate about why the message was rejected.";

export function messageText(message: string | UserContent): string {
	if (typeof message === "string") return message;
	return message
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join(" ");
}

/** Fails open, like the app: an unreachable or slow Lakera never blocks a visitor. */
export async function lakeraFlags(input: { text: string; instructions?: string }): Promise<boolean> {
	const { text } = input;
	const apiKey = process.env.LAKERA_API_KEY;
	if (!apiKey || !text.trim()) return false;
	try {
		const response = await fetch("https://api.lakera.ai/v2/guard", {
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({
				messages: [
					...(input.instructions ? [{ role: "system", content: input.instructions }] : []),
					{ role: "user", content: text },
				],
				...(process.env.LAKERA_PROJECT_ID ? { project_id: process.env.LAKERA_PROJECT_ID } : {}),
				breakdown: true,
			}),
			signal: AbortSignal.timeout(LAKERA_TIMEOUT_MS),
		});
		if (!response.ok) {
			console.warn("[guardrail] Lakera answered an error, failing open", { status: response.status });
			return false;
		}
		const body: unknown = await response.json();
		return typeof body === "object" && body !== null && "flagged" in body && body.flagged === true;
	} catch (error) {
		console.warn("[guardrail] Lakera check failed, failing open", {
			message: error instanceof Error ? error.message : "unknown",
		});
		return false;
	}
}
