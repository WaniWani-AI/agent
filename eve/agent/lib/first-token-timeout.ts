import type { LanguageModelMiddleware } from "ai";

type StreamResult = Awaited<ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_ATTEMPTS = 2;

/** Parts a provider sends before it has produced anything the turn can use. */
const PREAMBLE = new Set(["stream-start", "response-metadata", "raw", "text-start", "reasoning-start"]);

function isOutput(part: StreamPart): boolean {
	if (PREAMBLE.has(part.type)) return false;
	if (part.type === "text-delta" || part.type === "reasoning-delta") return part.delta !== "";
	return true;
}

export class FirstTokenTimeoutError extends Error {
	constructor(timeoutMs: number, attempts: number) {
		super(`The model produced no output within ${timeoutMs} ms, ${attempts} attempts`);
		this.name = "FirstTokenTimeoutError";
	}
}

function positiveInteger(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function firstTokenTimeoutFromEnv(): { timeoutMs: number; attempts: number } {
	return {
		timeoutMs: positiveInteger(process.env.WANIWANI_MODEL_FIRST_TOKEN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
		attempts: positiveInteger(process.env.WANIWANI_MODEL_FIRST_TOKEN_ATTEMPTS, DEFAULT_ATTEMPTS),
	};
}

type Reader = { read(): Promise<{ done: true; value?: StreamPart } | { done: false; value: StreamPart }>; cancel(reason?: unknown): Promise<void> };

function replay(buffered: StreamPart[], reader: Reader): ReadableStream<StreamPart> {
	return new ReadableStream<StreamPart>({
		async pull(controller) {
			const next = buffered.shift();
			if (next !== undefined) {
				controller.enqueue(next);
				return;
			}
			try {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

/**
 * A model call that has sent nothing after `timeoutMs` is aborted and made again,
 * up to `attempts` times. Nothing has streamed yet when it retries, so no text
 * or tool call can repeat.
 */
export function firstTokenTimeout(options: { timeoutMs: number; attempts: number }): LanguageModelMiddleware {
	const { timeoutMs, attempts } = options;
	return {
		async wrapStream({ model, params }) {
			const caller = params.abortSignal;
			for (let attempt = 1; ; attempt += 1) {
				const deadline = new AbortController();
				const timedOut = new Promise<never>((_, reject) => {
					deadline.signal.addEventListener("abort", () => reject(deadline.signal.reason), { once: true });
				});
				timedOut.catch(() => {});
				const timer = setTimeout(() => deadline.abort(new FirstTokenTimeoutError(timeoutMs, attempt)), timeoutMs);
				const signal = caller ? AbortSignal.any([caller, deadline.signal]) : deadline.signal;
				let release: (() => Promise<void>) | undefined;
				try {
					const result = await Promise.race([model.doStream({ ...params, abortSignal: signal }), timedOut]);
					const reader: Reader = result.stream.getReader();
					release = () => reader.cancel();
					const buffered: StreamPart[] = [];
					for (;;) {
						const next = await Promise.race([reader.read(), timedOut]);
						if (next.done) break;
						buffered.push(next.value);
						if (isOutput(next.value)) break;
					}
					clearTimeout(timer);
					return { ...result, stream: replay(buffered, reader) };
				} catch (error) {
					clearTimeout(timer);
					await release?.().catch(() => {});
					const expired = deadline.signal.aborted && !caller?.aborted;
					if (!expired) throw error;
					if (attempt >= attempts) throw new FirstTokenTimeoutError(timeoutMs, attempts);
					console.warn("[model] no output before the first-token deadline, retrying", {
						attempt,
						timeoutMs,
						modelId: model.modelId,
					});
				}
			}
		},
	};
}
