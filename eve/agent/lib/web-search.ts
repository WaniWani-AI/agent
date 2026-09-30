import type { LanguageModelMiddleware } from "ai";
import type { SessionConfig } from "./session-config.js";

const WEB_SEARCH = "web_search";
/** The AI Gateway search eve picks for a Gateway model, whose args take domain filters. */
const EXA_SEARCH = "gateway.exa_search";

function domains(list: string[] | null | undefined): string[] | undefined {
	return list && list.length > 0 ? list : undefined;
}

/**
 * eve compiles `web_search` into every agent. This keeps it on the model calls
 * of agents that turned search on, inside their domain filters, and drops it
 * wherever a filter could not be applied.
 */
export function webSearchScope(scope: SessionConfig["webSearch"]): LanguageModelMiddleware {
	const includeDomains = domains(scope?.includeDomains);
	const excludeDomains = domains(scope?.excludeDomains);
	const filtered = includeDomains !== undefined || excludeDomains !== undefined;
	return {
		transformParams: async ({ params }) => ({
			...params,
			tools: params.tools?.flatMap((tool) => {
				if (tool.type !== "provider" || tool.name !== WEB_SEARCH) return [tool];
				if (!scope) return [];
				if (!filtered) return [tool];
				if (tool.id !== EXA_SEARCH) return [];
				return [
					{
						...tool,
						args: {
							...tool.args,
							...(includeDomains ? { includeDomains } : {}),
							...(excludeDomains ? { excludeDomains } : {}),
						},
					},
				];
			}),
		}),
	};
}
