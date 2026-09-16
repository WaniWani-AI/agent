import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import express from "express";

const PORT = Number(process.env.PORT || 3004);
const KEY = "Bearer wwk_test";
/** Ingest takes the environment's browser-safe key, where the config route does not. */
const INGEST_KEY = "Bearer wwp_test";
const INGEST_PATH = "/api/mcp/events/v2/batch";
const PUBLIC_KEY_FILE = process.env.SERVICE_PUBLIC_KEY_FILE;

const BYO = {
	mode: "byo",
	provider: "litellm",
	modelId: "fixture/model",
	baseUrl: process.env.FIXTURE_MODEL_URL || "http://model:3003/v1",
	supportsStructuredOutputs: false,
	providerOptions: null,
};

const state = {
	failing: false,
	instructions: "You are a fixture assistant. Always call the echo tool first.",
	model: (process.env.FIXTURE_MODEL_MODE === "managed"
		? { mode: "managed", modelId: "openai/test" }
		: BYO) as Record<string, unknown>,
};

const events: unknown[] = [];

/** Mirrors the app: an environment key, or a service token this region trusts. */
function authorized(header: string | undefined): boolean {
	if (header === KEY) return true;
	if (!PUBLIC_KEY_FILE || !header?.startsWith("Bearer ")) return false;
	const [head, body, signature] = header.slice(7).split(".");
	if (!head || !body || !signature) return false;
	try {
		const claims = JSON.parse(Buffer.from(body, "base64url").toString());
		if (claims.iss !== "waniwani:agent-runtime") return false;
		if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return false;
		return verify(
			null,
			Buffer.from(`${head}.${body}`),
			createPublicKey(readFileSync(PUBLIC_KEY_FILE, "utf8")),
			Buffer.from(signature, "base64url"),
		);
	} catch {
		return false;
	}
}

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
	if (request.path === INGEST_PATH && request.headers.authorization === INGEST_KEY) {
		return next();
	}
	if (!authorized(request.headers.authorization)) {
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
