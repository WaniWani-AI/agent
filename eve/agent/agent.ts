import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent, defineDynamic } from "eve";
import { resolveModelAccess } from "./lib/model.js";
import { requireSnapshot } from "./lib/turn-snapshot.js";

const contextWindowTokens = Number(
	process.env.WANIWANI_MODEL_CONTEXT_WINDOW_TOKENS || 32_000,
);

export default defineAgent({
	defaultTools: false,
	// `step.started` is the only scope eve accepts a provider object from;
	// session and turn selections have to be serializable model ids.
	model: defineDynamic({
		events: {
			"step.started": (_event, ctx) => {
				const { config } = requireSnapshot(ctx.session.id);
				const access = resolveModelAccess(config.model);
				return {
					model: createOpenAI({
						baseURL: access.baseUrl,
						apiKey: access.apiKey,
					}).chat(access.modelId),
					modelContextWindowTokens: contextWindowTokens,
					...(access.providerOptions
						? { modelOptions: { providerOptions: access.providerOptions } }
						: {}),
				};
			},
		},
	}),
	experimental: { workflow: { world: "@workflow/world-postgres" } },
});
