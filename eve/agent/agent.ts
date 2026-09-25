import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent, defineDynamic } from "eve";
import { resolveModelAccess } from "./lib/model.js";
import { snapshotFor } from "./lib/turn-snapshot.js";

const contextWindowTokens = Number(
	process.env.WANIWANI_MODEL_CONTEXT_WINDOW_TOKENS || 32_000,
);

export default defineAgent({
	defaultTools: false,
	// `step.started` is the only scope eve accepts a provider object from;
	// session and turn selections have to be serializable model ids.
	model: defineDynamic({
		events: {
			"step.started": async (_event, ctx) => {
				const { config } = await snapshotFor({
					sessionId: ctx.session.id,
					auth: ctx.session.auth,
				});
				const access = resolveModelAccess(config.model);
				// Absent, eve reads a Gateway slug's window from the Gateway catalog.
				const windowTokens =
					access.contextWindowTokens ??
					(access.kind === "gateway" ? null : contextWindowTokens);
				return {
					model:
						access.kind === "gateway"
							? access.modelId
							: createOpenAI({ baseURL: access.baseUrl, apiKey: access.apiKey }).chat(
									access.modelId,
								),
					...(windowTokens ? { modelContextWindowTokens: windowTokens } : {}),
					...(access.providerOptions
						? { modelOptions: { providerOptions: access.providerOptions } }
						: {}),
				};
			},
		},
	}),
	...(process.env.VERCEL
		? {}
		: { experimental: { workflow: { world: "@workflow/world-postgres" } } }),
});
