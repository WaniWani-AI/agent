import { afterEach, beforeEach, expect, test } from "bun:test";
import { gateway, wrapLanguageModel } from "ai";
import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { FirstTokenTimeoutError, firstTokenTimeout, firstTokenTimeoutFromEnv } from "./first-token-timeout.js";

const PARAMS: LanguageModelV4CallOptions = { prompt: [] };

function stream(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
	return new ReadableStream({
		start(controller) {
			for (const part of parts) controller.enqueue(part);
			controller.close();
		},
	});
}

function neverEndingStream(): {
	stream: ReadableStream<LanguageModelV4StreamPart>;
	cancelled: Promise<unknown>;
} {
	let cancelReason!: (reason: unknown) => void;
	const cancelled = new Promise((resolve) => {
		cancelReason = resolve;
	});
	return {
		stream: new ReadableStream({
			cancel(reason) {
				cancelReason(reason);
			},
		}),
		cancelled,
	};
}

function fakeModel(
	doStream: (options: LanguageModelV4CallOptions) => PromiseLike<{ stream: ReadableStream<LanguageModelV4StreamPart> }>,
	overrides: Partial<LanguageModelV4> = {},
): LanguageModelV4 {
	return {
		specificationVersion: "v4",
		provider: "test-provider",
		modelId: "test-model",
		supportedUrls: {},
		doGenerate: () => {
			throw new Error("not implemented");
		},
		doStream,
		...overrides,
	};
}

async function drain(readable: ReadableStream<LanguageModelV4StreamPart>): Promise<LanguageModelV4StreamPart[]> {
	const reader = readable.getReader();
	const parts: LanguageModelV4StreamPart[] = [];
	for (;;) {
		const next = await reader.read();
		if (next.done) return parts;
		parts.push(next.value);
	}
}

async function wrap(
	model: LanguageModelV4,
	options: { timeoutMs: number; attempts: number },
	params: LanguageModelV4CallOptions = PARAMS,
) {
	const middleware = firstTokenTimeout(options);
	if (!middleware.wrapStream) throw new Error("expected wrapStream");
	return await middleware.wrapStream({
		model,
		params,
		doGenerate: () => model.doGenerate(params),
		doStream: () => model.doStream(params),
	});
}

test("a content part arriving before the deadline passes straight through, once per attempt", async () => {
	let calls = 0;
	const model = fakeModel(async () => {
		calls += 1;
		return { stream: stream([{ type: "text-start", id: "1" }, { type: "text-delta", id: "1", delta: "hi" }]) };
	});
	const result = await wrap(model, { timeoutMs: 50, attempts: 2 });
	expect(await drain(result.stream)).toEqual([
		{ type: "text-start", id: "1" },
		{ type: "text-delta", id: "1", delta: "hi" },
	]);
	expect(calls).toBe(1);
});

test("stream-start, response-metadata and raw parts alone do not count as content, so a stall behind them still times out", async () => {
	let calls = 0;
	const model = fakeModel(async () => {
		calls += 1;
		if (calls === 1) {
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						controller.enqueue({ type: "stream-start", warnings: [] });
						controller.enqueue({ type: "response-metadata" });
						controller.enqueue({ type: "raw", rawValue: {} });
						// Then nothing: a provider that acknowledged the request but
						// never produced a usable part.
					},
				}),
			};
		}
		return { stream: stream([{ type: "text-start", id: "2" }]) };
	});
	const result = await wrap(model, { timeoutMs: 30, attempts: 2 });
	expect(await drain(result.stream)).toEqual([{ type: "text-start", id: "2" }]);
	expect(calls).toBe(2);
});

test("a stream that closes having sent only preamble parts is treated as a complete, contentless response (not retried)", async () => {
	// Documents current behavior: `done` breaks the preamble loop before the
	// timeout ever fires, so this is not caught as a first-token timeout at all.
	let calls = 0;
	const model = fakeModel(async () => {
		calls += 1;
		return {
			stream: stream([
				{ type: "stream-start", warnings: [] },
				{ type: "response-metadata" },
			]),
		};
	});
	const result = await wrap(model, { timeoutMs: 30, attempts: 2 });
	expect(await drain(result.stream)).toEqual([
		{ type: "stream-start", warnings: [] },
		{ type: "response-metadata" },
	]);
	expect(calls).toBe(1);
});

test("attempts = 1 fails on the first timeout with no retry", async () => {
	const { stream: hungStream, cancelled } = neverEndingStream();
	let calls = 0;
	const model = fakeModel(async () => {
		calls += 1;
		return { stream: hungStream };
	});
	await expect(wrap(model, { timeoutMs: 20, attempts: 1 })).rejects.toBeInstanceOf(FirstTokenTimeoutError);
	expect(calls).toBe(1);
	await cancelled;
});

test("a timed-out attempt is retried up to `attempts` total calls, then fails with FirstTokenTimeoutError", async () => {
	let calls = 0;
	const model = fakeModel(async () => {
		calls += 1;
		return neverEndingStream();
	});
	const error = await wrap(model, { timeoutMs: 15, attempts: 3 }).catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(FirstTokenTimeoutError);
	expect((error as Error).message).toContain("3 attempts");
	expect(calls).toBe(3);
});

test("a later attempt can still succeed after earlier ones timed out", async () => {
	let calls = 0;
	const model = fakeModel(async () => {
		calls += 1;
		if (calls < 3) return neverEndingStream();
		return { stream: stream([{ type: "text-start", id: "ok" }, { type: "text-delta", id: "ok", delta: "hi" }]) };
	});
	const result = await wrap(model, { timeoutMs: 15, attempts: 3 });
	expect(await drain(result.stream)).toEqual([
		{ type: "text-start", id: "ok" },
		{ type: "text-delta", id: "ok", delta: "hi" },
	]);
	expect(calls).toBe(3);
});

test("once a non-empty delta has streamed, a slow follow-up part is never subject to the deadline", async () => {
	let releaseSecondPart: (() => void) | undefined;
	const slowSecondPart = new Promise<void>((resolve) => {
		releaseSecondPart = resolve;
	});
	let pulled = 0;
	const model = fakeModel(async () => ({
		stream: new ReadableStream<LanguageModelV4StreamPart>({
			async pull(controller) {
				pulled += 1;
				if (pulled === 1) {
					controller.enqueue({ type: "text-delta", id: "1", delta: "first" });
					return;
				}
				await slowSecondPart;
				controller.enqueue({ type: "text-delta", id: "1", delta: "late" });
				controller.close();
			},
		}),
	}));
	const result = await wrap(model, { timeoutMs: 20, attempts: 2 });
	const reader = result.stream.getReader();
	expect((await reader.read()).value).toEqual({ type: "text-delta", id: "1", delta: "first" });
	await Bun.sleep(60);
	releaseSecondPart?.();
	expect((await reader.read()).value).toEqual({ type: "text-delta", id: "1", delta: "late" });
	expect((await reader.read()).done).toBe(true);
});

test("text-start does not arm success; a stall behind it still times out and retries", async () => {
	let calls = 0;
	const model = fakeModel(async () => {
		calls += 1;
		if (calls === 1) {
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						controller.enqueue({ type: "text-start", id: "1" });
					},
				}),
			};
		}
		return { stream: stream([{ type: "text-delta", id: "2", delta: "ok" }]) };
	});
	const result = await wrap(model, { timeoutMs: 20, attempts: 2 });
	expect(await drain(result.stream)).toEqual([{ type: "text-delta", id: "2", delta: "ok" }]);
	expect(calls).toBe(2);
});

test("an empty delta does not count as output; a stall behind it still times out and retries", async () => {
	let calls = 0;
	const model = fakeModel(async () => {
		calls += 1;
		if (calls === 1) {
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						controller.enqueue({ type: "text-start", id: "1" });
						controller.enqueue({ type: "text-delta", id: "1", delta: "" });
					},
				}),
			};
		}
		return { stream: stream([{ type: "text-delta", id: "2", delta: "ok" }]) };
	});
	const result = await wrap(model, { timeoutMs: 20, attempts: 2 });
	expect(await drain(result.stream)).toEqual([{ type: "text-delta", id: "2", delta: "ok" }]);
	expect(calls).toBe(2);
});

test("reasoning-start does not arm success on its own, but a non-empty reasoning-delta arriving in time does", async () => {
	let calls = 0;
	const model = fakeModel(async () => {
		calls += 1;
		return {
			stream: stream([
				{ type: "reasoning-start", id: "r1" },
				{ type: "reasoning-delta", id: "r1", delta: "thinking" },
			]),
		};
	});
	const result = await wrap(model, { timeoutMs: 5_000, attempts: 2 });
	expect(await drain(result.stream)).toEqual([
		{ type: "reasoning-start", id: "r1" },
		{ type: "reasoning-delta", id: "r1", delta: "thinking" },
	]);
	expect(calls).toBe(1);
});

test("a caller abort during the model call is never turned into a retry", async () => {
	const controller = new AbortController();
	let calls = 0;
	const model = fakeModel(async (options) => {
		calls += 1;
		return new Promise((_, reject) => {
			options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal?.reason), { once: true });
		});
	});
	const reason = new Error("caller went away");
	setTimeout(() => controller.abort(reason), 5);
	const error = await wrap(model, { timeoutMs: 5_000, attempts: 3 }, { ...PARAMS, abortSignal: controller.signal }).catch(
		(caught: unknown) => caught,
	);
	expect(error).toBe(reason);
	expect(calls).toBe(1);
});

test("a caller abort raised while reading the stream (after doStream resolves) is not retried either", async () => {
	const controller = new AbortController();
	let calls = 0;
	const model = fakeModel(async (options) => {
		calls += 1;
		return {
			stream: new ReadableStream<LanguageModelV4StreamPart>({
				pull(streamController) {
					return new Promise((_, reject) => {
						options.abortSignal?.addEventListener(
							"abort",
							() => {
								streamController.error(options.abortSignal?.reason);
								reject(options.abortSignal?.reason);
							},
							{ once: true },
						);
					});
				},
			}),
		};
	});
	const reason = new Error("caller went away mid-read");
	setTimeout(() => controller.abort(reason), 5);
	const error = await wrap(model, { timeoutMs: 5_000, attempts: 3 }, { ...PARAMS, abortSignal: controller.signal }).catch(
		(caught: unknown) => caught,
	);
	expect(error).toBe(reason);
	expect(calls).toBe(1);
});

test("a non-timeout failure from the model is never retried", async () => {
	let calls = 0;
	const boom = new Error("upstream 500");
	const model = fakeModel(async () => {
		calls += 1;
		throw boom;
	});
	const error = await wrap(model, { timeoutMs: 5_000, attempts: 3 }).catch((caught: unknown) => caught);
	expect(error).toBe(boom);
	expect(calls).toBe(1);
});

test("a wrapped Gateway model keeps the gateway provider id and its exact model id", () => {
	const middleware = firstTokenTimeout({ timeoutMs: 15_000, attempts: 2 });
	const wrapped = wrapLanguageModel({ model: gateway("anthropic/claude-3-haiku"), middleware });
	expect(wrapped.provider.startsWith("gateway")).toBe(true);
	expect(wrapped.modelId).toBe("anthropic/claude-3-haiku");
});

const ENV_KEYS = ["WANIWANI_MODEL_FIRST_TOKEN_TIMEOUT_MS", "WANIWANI_MODEL_FIRST_TOKEN_ATTEMPTS"] as const;
let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof saved;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = saved[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("firstTokenTimeoutFromEnv defaults to 15000ms / 2 attempts when unset", () => {
	delete process.env.WANIWANI_MODEL_FIRST_TOKEN_TIMEOUT_MS;
	delete process.env.WANIWANI_MODEL_FIRST_TOKEN_ATTEMPTS;
	expect(firstTokenTimeoutFromEnv()).toEqual({ timeoutMs: 15_000, attempts: 2 });
});

test("firstTokenTimeoutFromEnv reads valid positive integers from the environment", () => {
	process.env.WANIWANI_MODEL_FIRST_TOKEN_TIMEOUT_MS = "9000";
	process.env.WANIWANI_MODEL_FIRST_TOKEN_ATTEMPTS = "4";
	expect(firstTokenTimeoutFromEnv()).toEqual({ timeoutMs: 9_000, attempts: 4 });
});

for (const bad of ["0", "-5", "3.5", "not-a-number", ""]) {
	test(`firstTokenTimeoutFromEnv falls back to the default for an invalid value (${JSON.stringify(bad)})`, () => {
		process.env.WANIWANI_MODEL_FIRST_TOKEN_TIMEOUT_MS = bad;
		process.env.WANIWANI_MODEL_FIRST_TOKEN_ATTEMPTS = bad;
		expect(firstTokenTimeoutFromEnv()).toEqual({ timeoutMs: 15_000, attempts: 2 });
	});
}
