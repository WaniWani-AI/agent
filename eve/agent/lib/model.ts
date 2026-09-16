import type { JsonObject } from "./json.js";
import type { SessionModel } from "./session-config.js";

const DEFAULT_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v1";

export type ModelAccess = {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	providerOptions: Record<string, JsonObject> | null;
};

function required(name: string, value: string | undefined): string {
	if (!value) {
		throw new Error(`${name} is not set, and this agent has no fallback model`);
	}
	return value;
}

/** Pure: the `turn.started` gate calls it to fail the turn, `step.started` to build the provider. */
export function resolveModelAccess(model: SessionModel): ModelAccess {
	if (model.mode === "byo") {
		return {
			baseUrl: model.baseUrl,
			apiKey: model.apiKey ?? required("MODEL_API_KEY", process.env.MODEL_API_KEY),
			modelId: model.modelId,
			providerOptions: model.providerOptions ?? null,
		};
	}
	return {
		baseUrl: process.env.AI_GATEWAY_BASE_URL || DEFAULT_GATEWAY_BASE_URL,
		apiKey: required("AI_GATEWAY_API_KEY", process.env.AI_GATEWAY_API_KEY),
		modelId: model.modelId,
		providerOptions: null,
	};
}
