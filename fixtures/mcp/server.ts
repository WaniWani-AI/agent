import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ListResourcesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { agentRouter } from "../../packages/adapter/src/express.js";

const PORT = Number(process.env.PORT || 3002);
const WIDGET_URI = "ui://views/ext-apps/echo.html";

const calls: unknown[] = [];
let authorization: string | null = null;

const TOOLS = [
	{
		name: "echo",
		description: "Echoes the text it is given.",
		inputSchema: {
			type: "object" as const,
			properties: {
				text: { type: "string", description: "Text to echo." },
				sessionId: { type: "string" },
			},
			required: ["text"],
		},
	},
];

const RESOURCES = [
	{ uri: WIDGET_URI, name: "echo widget", mimeType: "text/html+skybridge" },
];

function createServer(): Server {
	const server = new Server(
		{ name: "fixture-mcp", version: "1.0.0" },
		{ capabilities: { tools: {}, resources: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
	server.setRequestHandler(ListResourcesRequestSchema, () => ({
		resources: RESOURCES,
	}));
	server.setRequestHandler(ReadResourceRequestSchema, () => ({
		contents: [
			{
				uri: WIDGET_URI,
				mimeType: "text/html+skybridge",
				text: '<div id="echo"></div>',
			},
		],
	}));
	server.setRequestHandler(CallToolRequestSchema, (request) => {
		const args = (request.params.arguments ?? {}) as { text?: string };
		calls.push({
			name: request.params.name,
			arguments: args,
			authorization,
			_meta: request.params._meta ?? null,
		});
		return {
			content: [{ type: "text" as const, text: `echo: ${args.text ?? ""}` }],
			_meta: { "openai/outputTemplate": WIDGET_URI },
		};
	});

	return server;
}

const app = express();

// The mount PR 8 gives the template: one env var, one router, beside `/mcp`.
const eveUrl = process.env.WANIWANI_AGENT_EVE_URL;
if (eveUrl) {
	app.use(
		"/agent/v1",
		agentRouter({
			eveUrl,
			apiKey: process.env.WANIWANI_API_KEY ?? "",
			publicKey: process.env.WANIWANI_PUBLIC_KEY ?? "",
			allowedOrigins: (process.env.WANIWANI_ALLOWED_ORIGINS ?? "")
				.split(",")
				.filter(Boolean),
			title: "Fixture MCP",
			mcpLoopbackUrl: `http://127.0.0.1:${PORT}/mcp`,
		}),
	);
}

app.use(express.json());

app.get("/_calls", (_request, response) => response.json({ calls }));
app.delete("/_calls", (_request, response) => {
	calls.length = 0;
	response.status(204).end();
});

app.post("/mcp", async (request, response) => {
	authorization = request.headers.authorization ?? null;
	const server = createServer();
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	});
	response.on("close", () => {
		void transport.close();
		void server.close();
	});
	await server.connect(transport);
	await transport.handleRequest(request, response, request.body);
});

app.get("/mcp", (_request, response) => response.status(405).end());
app.delete("/mcp", (_request, response) => response.status(405).end());

app.listen(PORT, () => console.log(`[fixture mcp] listening on ${PORT}`));
