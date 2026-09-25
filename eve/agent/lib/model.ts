import type { JsonObject } from "./json.js";
import type { SessionModel } from "./session-config.js";

export type ProviderOptions = Record<string, JsonObject>;

/**
 * A `gateway` model is a slug eve hands to the AI Gateway provider, which reads
 * `providerOptions.gateway` (the app's fallback chain). An `openai-compatible`
 * model is an endpoint the runtime builds a provider object for.
 */
export type ModelAccess =
	| {
			kind: "gateway";
			modelId: string;
			providerOptions: ProviderOptions | null;
			contextWindowTokens: number | null;
	  }
	| {
			kind: "openai-compatible";
			baseUrl: string;
			apiKey: string;
			modelId: string;
			providerOptions: ProviderOptions | null;
			contextWindowTokens: number | null;
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
			kind: "openai-compatible",
			baseUrl: model.baseUrl,
			apiKey: model.apiKey ?? required("MODEL_API_KEY", process.env.MODEL_API_KEY),
			modelId: model.modelId,
			providerOptions: model.providerOptions ?? null,
			contextWindowTokens: null,
		};
	}
	const providerOptions = model.providerOptions ?? null;
	const contextWindowTokens = model.contextWindowTokens ?? null;
	const baseUrl = process.env.AI_GATEWAY_BASE_URL;
	if (baseUrl) {
		return {
			kind: "openai-compatible",
			baseUrl,
			apiKey: required("AI_GATEWAY_API_KEY", process.env.AI_GATEWAY_API_KEY),
			modelId: model.modelId,
			providerOptions,
			contextWindowTokens,
		};
	}
	// On Vercel the Gateway provider falls back to the project's OIDC token.
	if (!process.env.VERCEL) required("AI_GATEWAY_API_KEY", process.env.AI_GATEWAY_API_KEY);
	return { kind: "gateway", modelId: model.modelId, providerOptions, contextWindowTokens };
}
