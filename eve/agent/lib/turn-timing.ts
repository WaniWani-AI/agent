import { randomUUID } from "node:crypto";
import type { LanguageModelMiddleware } from "ai";

const INSTANCE = randomUUID().slice(0, 8);
const STARTED_AT = Date.now();

/** One line per mark, so a turn whose steps land on different instances still lines up by session and time. */
export function timing(mark: string, fields: Record<string, unknown> = {}): void {
	console.log(
		"[eve.timing]",
		JSON.stringify({ mark, at: Date.now(), instance: INSTANCE, uptimeMs: Date.now() - STARTED_AT, ...fields }),
	);
}

timing("process.start");

const PREAMBLE = new Set(["stream-start", "response-metadata", "raw", "text-start", "reasoning-start"]);

export function modelTiming(sessionId: string): LanguageModelMiddleware {
	return {
		async wrapStream({ doStream, model }) {
			const startedAt = Date.now();
			timing("model.request", { sessionId, modelId: model.modelId });
			const result = await doStream();
			const headersMs = Date.now() - startedAt;
			let seen = false;
			const tap = new TransformStream({
				transform(part, controller) {
					if (!seen && !PREAMBLE.has(part.type)) {
						seen = true;
						timing("model.first_output", { sessionId, headersMs, firstOutputMs: Date.now() - startedAt, part: part.type });
					}
					controller.enqueue(part);
				},
			});
			return { ...result, stream: result.stream.pipeThrough(tap) };
		},
	};
}
