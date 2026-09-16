import type { EveEvent } from "./eve-client.js";

/**
 * The runtime's event stream, translated into the AI SDK UI message stream the
 * SDK's chat embed consumes. With `eve-client.ts`, the only file here that
 * knows which agent framework produced the events.
 */

/** The chunks this translation emits, typed here so the package needs no `ai` dependency. */
export type UIMessageChunk =
	| { type: "start"; messageId?: string }
	| { type: "start-step" }
	| { type: "finish-step" }
	| { type: "finish"; finishReason?: "stop" | "error" }
	| { type: "text-start"; id: string }
	| { type: "text-delta"; id: string; delta: string }
	| { type: "text-end"; id: string }
	| { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown; dynamic?: boolean }
	| { type: "tool-output-available"; toolCallId: string; output: unknown; dynamic?: boolean }
	| { type: "tool-output-error"; toolCallId: string; errorText: string; dynamic?: boolean }
	| { type: "message-metadata"; messageMetadata: Record<string, unknown> }
	| { type: "error"; errorText: string };

export type WidgetContext = {
	endpoint: string;
	sessionId: string;
	source: string;
	/** What the widget presents to `endpoint`, which is the router's own key. */
	token: string;
};

type Controller = TransformStreamDefaultController<UIMessageChunk>;

type ToolAction = {
	kind?: string;
	callId?: string;
	toolName?: string;
	input?: unknown;
	output?: unknown;
	isError?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

/**
 * The three spellings of a view binding are not alternatives to choose between:
 * they are what three host generations emit, and the SDK renders all three. See
 * `resourceUriFromMeta` in the SDK's `shared/view-uri.ts`.
 */
function bindsView(meta: Record<string, unknown>): boolean {
	const candidates = [
		asRecord(meta.ui)?.resourceUri,
		meta["ui/resourceUri"],
		meta["openai/outputTemplate"],
	];
	return candidates.some(
		(candidate) => typeof candidate === "string" && candidate.length > 0,
	);
}

/**
 * Tells a rendered MCP App resource where to send its own events, merged over
 * what the server already stamped. The endpoint and the token travel together,
 * or the widget authenticates against the wrong door.
 */
export function withWidgetContext(output: unknown, context: WidgetContext): unknown {
	const result = asRecord(output);
	const meta = result && asRecord(result._meta);
	if (!result || !meta || !bindsView(meta)) {
		return output;
	}
	const existing = asRecord(meta["waniwani/widget"]) ?? {};
	return {
		...result,
		_meta: { ...meta, "waniwani/widget": { ...existing, ...context } },
	};
}

export function uiMessageChunks(): TransformStream<EveEvent, UIMessageChunk> {
	const announced = new Set<string>();
	const models = new Map<number, string>();
	let textId: string | undefined;
	let textCount = 0;
	let stepOpen = false;
	let failed = false;

	const startText = (controller: Controller): string => {
		if (!textId) {
			textId = `text-${++textCount}`;
			controller.enqueue({ type: "text-start", id: textId });
		}
		return textId;
	};
	const endText = (controller: Controller): void => {
		if (textId) {
			controller.enqueue({ type: "text-end", id: textId });
			textId = undefined;
		}
	};
	const write = (controller: Controller, delta: string): void => {
		controller.enqueue({ type: "text-delta", id: startText(controller), delta });
	};
	const announce = (controller: Controller, call: ToolAction, input: unknown): void => {
		if (!call.callId || announced.has(call.callId)) return;
		announced.add(call.callId);
		controller.enqueue({
			type: "tool-input-available",
			toolCallId: call.callId,
			toolName: call.toolName ?? call.kind ?? "tool",
			input,
			dynamic: true,
		});
	};

	return new TransformStream<EveEvent, UIMessageChunk>({
		start(controller) {
			controller.enqueue({ type: "start", messageId: crypto.randomUUID() });
		},

		transform(event, controller) {
			switch (event.type) {
				case "step.started": {
					const { modelId, stepIndex } = event.data as { modelId?: string; stepIndex?: number };
					if (typeof stepIndex === "number" && modelId) models.set(stepIndex, modelId);
					controller.enqueue({ type: "start-step" });
					stepOpen = true;
					break;
				}

				case "message.appended": {
					const { messageDelta } = event.data as { messageDelta?: string };
					if (messageDelta) write(controller, messageDelta);
					break;
				}

				case "message.completed": {
					const { message } = event.data as { message?: string };
					if (!textId && message) write(controller, message);
					endText(controller);
					break;
				}

				case "actions.requested": {
					endText(controller);
					const { actions } = event.data as { actions?: ToolAction[] };
					for (const action of actions ?? []) {
						announce(controller, action, action.input);
					}
					break;
				}

				case "action.result": {
					const { result, status, error } = event.data as {
						result?: ToolAction;
						status?: string;
						error?: { message?: string };
					};
					if (result?.kind !== "tool-result" || !result.callId) break;
					announce(controller, result, {});

					// A rejected or erroring call must never reach the embed as a success
					// chunk: the widget would render an error body as its output.
					if (result.isError === true || (status && status !== "completed")) {
						controller.enqueue({
							type: "tool-output-error",
							toolCallId: result.callId,
							errorText: error?.message ?? "The tool call failed.",
							dynamic: true,
						});
						break;
					}
					controller.enqueue({
						type: "tool-output-available",
						toolCallId: result.callId,
						output: result.output,
						dynamic: true,
					});
					break;
				}

				case "step.completed": {
					const { stepIndex, usage } = event.data as { stepIndex?: number; usage?: unknown };
					endText(controller);
					if (stepOpen) {
						controller.enqueue({ type: "finish-step" });
						stepOpen = false;
					}
					const modelId =
						typeof stepIndex === "number" ? models.get(stepIndex) : undefined;
					controller.enqueue({
						type: "message-metadata",
						messageMetadata: { "waniwani/step": { stepIndex, modelId, usage } },
					});
					break;
				}

				case "turn.failed":
				case "session.failed": {
					const { message } = event.data as { message?: string };
					failed = true;
					controller.enqueue({
						type: "error",
						errorText: message ?? "The agent could not answer.",
					});
					break;
				}
			}
		},

		flush(controller) {
			endText(controller);
			if (stepOpen) controller.enqueue({ type: "finish-step" });
			controller.enqueue({ type: "finish", finishReason: failed ? "error" : "stop" });
		},
	});
}
