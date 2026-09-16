import type { JsonObject } from "./json.js";
import { configRequest, type Tenant } from "./tenant.js";

export type SessionModel =
	| { mode: "managed"; modelId: string }
	| {
			mode: "byo";
			provider: string;
			modelId: string;
			baseUrl: string;
			apiKey?: string;
			supportsStructuredOutputs?: boolean;
			providerOptions?: Record<string, JsonObject> | null;
	  };

export type SessionChannel = {
	id: string;
	label: string | null;
	title: string | null;
};

export type SessionConfig = {
	environmentId: string;
	configId: string;
	instructions: string;
	model: SessionModel;
	mcpUrl: string;
	webSearch: {
		includeDomains: string[] | null;
		excludeDomains: string[] | null;
	} | null;
	channels: SessionChannel[];
};

export type Fetched = { etag?: string; value: SessionConfig };

async function unwrap(response: Response): Promise<unknown> {
	const body: unknown = await response.json().catch(() => null);
	const envelope =
		typeof body === "object" && body !== null
			? (body as { data?: unknown; message?: unknown })
			: {};
	if (!response.ok) {
		const detail =
			typeof envelope.message === "string"
				? envelope.message
				: response.statusText;
		throw new Error(
			`Agent configuration failed (${response.status}): ${detail}`,
		);
	}
	return envelope.data;
}

function readModel(value: unknown): SessionModel {
	const model = (value ?? {}) as Record<string, unknown>;
	const modelId = model.modelId;
	if (typeof modelId !== "string" || !modelId) {
		throw new Error("Agent configuration returned no usable model");
	}
	if (model.mode === "managed") {
		return { mode: "managed", modelId };
	}
	if (model.mode === "byo") {
		if (typeof model.provider !== "string") {
			throw new Error("Own-model configuration named no provider");
		}
		if (typeof model.baseUrl !== "string" || !model.baseUrl) {
			throw new Error("Own-model configuration named no base URL");
		}
		return {
			mode: "byo",
			provider: model.provider,
			modelId,
			baseUrl: model.baseUrl,
			...(typeof model.apiKey === "string" && model.apiKey
				? { apiKey: model.apiKey }
				: {}),
			supportsStructuredOutputs:
				typeof model.supportsStructuredOutputs === "boolean"
					? model.supportsStructuredOutputs
					: undefined,
			providerOptions:
				(model.providerOptions as Record<string, JsonObject> | null) ?? null,
		};
	}
	throw new Error(`Unsupported model provider mode: ${String(model.mode)}`);
}

function readChannels(value: unknown): SessionChannel[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry: unknown) => {
		const channel = entry as Partial<SessionChannel>;
		return typeof channel?.id === "string"
			? [
					{
						id: channel.id,
						label: channel.label ?? null,
						title: channel.title ?? null,
					},
				]
			: [];
	});
}

export async function fetchSessionConfig(input: {
	tenant: Tenant;
	previous?: Fetched;
}): Promise<Fetched> {
	const { url, authorization } = configRequest(input.tenant);
	const response = await fetch(url, {
		headers: {
			authorization,
			...(input.previous?.etag
				? { "if-none-match": input.previous.etag }
				: {}),
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (response.status === 304 && input.previous) {
		return input.previous;
	}

	const data = (await unwrap(response)) as Partial<SessionConfig> | undefined;
	if (
		typeof data?.environmentId !== "string" ||
		typeof data.configId !== "string" ||
		typeof data.mcpUrl !== "string" ||
		typeof data.instructions !== "string" ||
		!data.instructions.trim()
	) {
		throw new Error("Agent configuration is incomplete");
	}
	return {
		etag: response.headers.get("etag") ?? undefined,
		value: {
			environmentId: data.environmentId,
			configId: data.configId,
			instructions: data.instructions,
			model: readModel(data.model),
			mcpUrl: data.mcpUrl,
			webSearch: data.webSearch ?? null,
			channels: readChannels(data.channels),
		},
	};
}
