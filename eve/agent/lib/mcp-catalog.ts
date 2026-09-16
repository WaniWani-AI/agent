import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonObject } from "./json.js";
import { credentialForm } from "./tenant.js";
import { textOf } from "./tool-output.js";

export type McpTool = {
	name: string;
	description?: string;
	inputSchema: JsonObject;
};

export type McpMeta = Record<string, unknown>;

/**
 * Keyed by tenant and endpoint together. A turn holds the `mcpUrl` it snapshotted
 * for its whole duration, so a republished URL has to open a second client rather
 * than close the one an older turn is still calling.
 */
const clients = new Map<string, Promise<Client>>();

function mcpEndpoint(mcpUrl: string): string {
	return `${process.env.WANIWANI_MCP_URL || mcpUrl}/mcp`;
}

function cacheKey(tenantKey: string, endpoint: string): string {
	return `${tenantKey}\u0000${endpoint}`;
}

/**
 * A customer's MCP server authenticates the environment key, the way the app's
 * own `agentServerAuthHeader` forwards it. A hosted runtime holds no such key,
 * because the app stores only its hash, so it sends none.
 */
function upstreamHeaders(): Record<string, string> | undefined {
	if (credentialForm() !== "self-hosted") return undefined;
	const apiKey = process.env.WANIWANI_API_KEY;
	return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

async function connect(endpoint: string): Promise<Client> {
	const client = new Client({ name: "waniwani-agent", version: "1.0.0" });
	const headers = upstreamHeaders();
	await client.connect(
		new StreamableHTTPClientTransport(new URL(endpoint), {
			...(headers ? { requestInit: { headers } } : {}),
		}),
	);
	return client;
}

function clientFor(tenantKey: string, endpoint: string): Promise<Client> {
	const key = cacheKey(tenantKey, endpoint);
	const open = clients.get(key);
	if (open) {
		return open;
	}

	const client = connect(endpoint).catch((error: unknown) => {
		if (clients.get(key) === client) clients.delete(key);
		throw error;
	});
	clients.set(key, client);
	return client;
}

function forget(tenantKey: string, endpoint: string): void {
	const key = cacheKey(tenantKey, endpoint);
	const open = clients.get(key);
	clients.delete(key);
	void open?.then((client) => client.close()).catch(() => {});
}

const MAX_TOOL_PAGES = 50;

export async function listMcpTools(input: {
	tenantKey: string;
	mcpUrl: string;
}): Promise<McpTool[]> {
	const endpoint = mcpEndpoint(input.mcpUrl);
	const client = await clientFor(input.tenantKey, endpoint);
	try {
		const collected: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
			const result = await client.listTools(cursor ? { cursor } : undefined);
			for (const tool of result.tools) {
				collected.push({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema as JsonObject,
				});
			}
			if (!result.nextCursor || result.nextCursor === cursor) {
				return collected;
			}
			cursor = result.nextCursor;
		}
		throw new Error(`MCP server paged past ${MAX_TOOL_PAGES} tool pages`);
	} catch (error) {
		forget(input.tenantKey, endpoint);
		throw error;
	}
}

export async function callMcpTool(input: {
	tenantKey: string;
	mcpUrl: string;
	name: string;
	arguments: Record<string, unknown>;
	meta: McpMeta;
	abortSignal: AbortSignal;
}): Promise<unknown> {
	const endpoint = mcpEndpoint(input.mcpUrl);
	const client = await clientFor(input.tenantKey, endpoint);
	const signal = AbortSignal.any([
		input.abortSignal,
		AbortSignal.timeout(60_000),
	]);
	const result = await client
		.callTool(
			{ name: input.name, arguments: input.arguments, _meta: input.meta },
			undefined,
			{ signal },
		)
		.catch((error: unknown) => {
			// The client is shared by every session on this tenant, so one cancelled
			// call must not close it out from under the others.
			if (!signal.aborted) forget(input.tenantKey, endpoint);
			throw error;
		});

	if (result.isError) {
		throw new Error(textOf(result) || `Tool ${input.name} failed`);
	}
	return result;
}
