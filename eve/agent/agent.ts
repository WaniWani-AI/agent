import { createOpenAI } from "@ai-sdk/openai";
import { gateway, wrapLanguageModel } from "ai";
import { defineAgent, defineDynamic } from "eve";
import { firstTokenTimeout, firstTokenTimeoutFromEnv } from "./lib/first-token-timeout.js";
import { resolveModelAccess } from "./lib/model.js";
import { snapshotFor } from "./lib/turn-snapshot.js";
import { webSearchScope } from "./lib/web-search.js";

const contextWindowTokens = Number(
	process.env.WANIWANI_MODEL_CONTEXT_WINDOW_TOKENS || 32_000,
);

const firstToken = firstTokenTimeout(firstTokenTimeoutFromEnv());

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
				const model =
					access.kind === "gateway"
						? gateway(access.modelId)
						: createOpenAI({ baseURL: access.baseUrl, apiKey: access.apiKey }).chat(access.modelId);
				return {
					// A wrapped Gateway model keeps provider `gateway` and its slug, so eve still
					// reads its context window from the Gateway catalog.
					model: wrapLanguageModel({
						model,
						// Search goes through the Gateway, so an own-model endpoint never gets it.
						middleware: [
							firstToken,
							webSearchScope(access.kind === "gateway" ? config.webSearch : null),
						],
					}),
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
