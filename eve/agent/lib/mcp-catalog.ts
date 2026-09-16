import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonObject } from "./json.js";

export type McpTool = {
	name: string;
	description?: string;
	inputSchema: JsonObject;
};

export type McpMeta = Record<string, unknown>;

const clients = new Map<string, Promise<Client>>();

function mcpEndpoint(mcpUrl: string): string {
	return `${process.env.WANIWANI_MCP_URL ?? mcpUrl}/mcp`;
}

async function connect(endpoint: string): Promise<Client> {
	const client = new Client({ name: "waniwani-agent", version: "1.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
	return client;
}

function clientFor(tenantKey: string, mcpUrl: string): Promise<Client> {
	const endpoint = mcpEndpoint(mcpUrl);
	let client = clients.get(tenantKey);
	if (!client) {
		client = connect(endpoint).catch((error: unknown) => {
			clients.delete(tenantKey);
			throw error;
		});
		clients.set(tenantKey, client);
	}
	return client;
}

function forget(tenantKey: string): void {
	const client = clients.get(tenantKey);
	clients.delete(tenantKey);
	void client?.then((open) => open.close()).catch(() => {});
}

export async function listMcpTools(input: {
	tenantKey: string;
	mcpUrl: string;
}): Promise<McpTool[]> {
	const client = await clientFor(input.tenantKey, input.mcpUrl);
	try {
		const { tools } = await client.listTools();
		return tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema as JsonObject,
		}));
	} catch (error) {
		forget(input.tenantKey);
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
	const client = await clientFor(input.tenantKey, input.mcpUrl);
	const result = await client
		.callTool(
			{ name: input.name, arguments: input.arguments, _meta: input.meta },
			undefined,
			{
				signal: AbortSignal.any([
					input.abortSignal,
					AbortSignal.timeout(60_000),
				]),
			},
		)
		.catch((error: unknown) => {
			forget(input.tenantKey);
			throw error;
		});

	if (result.isError) {
		throw new Error(textOf(result) || `Tool ${input.name} failed`);
	}
	return result;
}

export function textOf(result: unknown): string {
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(part: unknown): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}
