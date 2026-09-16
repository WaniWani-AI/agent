import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonObject } from "./json.js";

export type McpTool = {
	name: string;
	description?: string;
	inputSchema: JsonObject;
};

export type McpMeta = Record<string, unknown>;

const clients = new Map<string, { endpoint: string; client: Promise<Client> }>();

function mcpEndpoint(mcpUrl: string): string {
	return `${process.env.WANIWANI_MCP_URL || mcpUrl}/mcp`;
}

async function connect(endpoint: string): Promise<Client> {
	const client = new Client({ name: "waniwani-agent", version: "1.0.0" });
	await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
	return client;
}

function clientFor(tenantKey: string, mcpUrl: string): Promise<Client> {
	const endpoint = mcpEndpoint(mcpUrl);
	const open = clients.get(tenantKey);
	if (open?.endpoint === endpoint) {
		return open.client;
	}
	if (open) forget(tenantKey);

	const entry: { endpoint: string; client: Promise<Client> } = {
		endpoint,
		client: connect(endpoint).catch((error: unknown) => {
			if (clients.get(tenantKey) === entry) clients.delete(tenantKey);
			throw error;
		}),
	};
	clients.set(tenantKey, entry);
	return entry.client;
}

function forget(tenantKey: string): void {
	const open = clients.get(tenantKey);
	clients.delete(tenantKey);
	void open?.client.then((client) => client.close()).catch(() => {});
}

const MAX_TOOL_PAGES = 50;

export async function listMcpTools(input: {
	tenantKey: string;
	mcpUrl: string;
}): Promise<McpTool[]> {
	const client = await clientFor(input.tenantKey, input.mcpUrl);
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
			if (!signal.aborted) forget(input.tenantKey);
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
