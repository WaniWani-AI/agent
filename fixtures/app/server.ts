import { createHash } from "node:crypto";
import express from "express";

const PORT = Number(process.env.PORT || 3004);
const KEY = "Bearer wwk_test";

const state = {
	failing: false,
	instructions: "You are a fixture assistant. Always call the echo tool first.",
	model: { mode: "byo", provider: "litellm", modelId: "fixture/model", baseUrl: process.env.FIXTURE_MODEL_URL || "http://model:3003/v1", supportsStructuredOutputs: false, providerOptions: null } as Record<string, unknown>,
};

const events: unknown[] = [];

function payload() {
	return {
		environmentId: "11111111-1111-4111-8111-111111111111",
		configId: "22222222-2222-4222-8222-222222222222",
		instructions: state.instructions,
		model: state.model,
		mcpUrl: process.env.FIXTURE_MCP_URL || "http://mcp:3002",
		webSearch: null,
		channels: [{ id: "33333333-3333-4333-8333-333333333333", label: "website", title: "Website" }],
	};
}

const app = express();
app.use(express.json({ limit: "5mb" }));

app.post("/_control", (request, response) => {
	Object.assign(state, request.body);
	response.json(state);
});

app.get("/_events", (_request, response) => response.json({ events }));

app.use((request, response, next) => {
	if (request.path.startsWith("/_")) return next();
	if (request.headers.authorization !== KEY) {
		return response.status(401).json({ success: false, message: "UNAUTHORIZED" });
	}
	if (state.failing) {
		return response.status(500).json({ success: false, message: "FIXTURE_DOWN" });
	}
	next();
});

app.get("/api/mcp/agent/config", (request, response) => {
	const data = payload();
	const etag = `"${createHash("sha256").update(JSON.stringify(data)).digest("base64url").slice(0, 27)}"`;
	response.setHeader("etag", etag);
	response.setHeader("cache-control", "private, no-cache");
	if (request.headers["if-none-match"] === etag) return response.status(304).end();
	response.json({ success: true, message: "success", data });
});

app.post("/api/mcp/events/v2/batch", (request, response) => {
	events.push(request.body);
	response.json({ success: true, message: "success", data: { accepted: 1 } });
});

app.listen(PORT, () => console.log(`[fixture app] listening on ${PORT}`));
