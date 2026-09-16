import { timingSafeEqual } from "node:crypto";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import cors from "cors";
import express, {
	type ErrorRequestHandler,
	type Request,
	type RequestHandler,
	type Response,
	type Router,
} from "express";
import { EveError, cancelTurn, encodeSse, runTurn, runtimeHealth } from "./core.js";
import { type UIMessageChunk, type WidgetContext, withWidgetContext } from "./ui-stream.js";

const VIEW_RESOURCE = /^ui:\/\/views\/ext-apps\/[a-zA-Z0-9_-]+\.html(?:\?v=[a-zA-Z0-9]+)?$/;
const BODY_LIMIT = "1mb";
const WINDOW_MS = 60_000;
const WINDOW_REQUESTS = 60;
const MAX_EVENTS = 100;
const UPSTREAM_TIMEOUT_MS = 10_000;

export type AgentRouterOptions = {
	/** Where the agent runtime listens, e.g. `http://eve:3001`. */
	eveUrl: string;
	/** The environment key (`wwk_…`) this server already holds. It never reaches a browser. */
	apiKey: string;
	/** The environment's public key (`wwp_…`), which is what browsers present. */
	publicKey: string;
	/** Exact origins allowed to post. No wildcards, no suffix matching. */
	allowedOrigins: string[];
	title: string;
	/** This same process's `/mcp` route, e.g. `http://127.0.0.1:3000/mcp`. */
	mcpLoopbackUrl: string;
};

function publicOrigin(req: Request): URL {
	const forwarded = req.get("x-forwarded-host")?.split(",")[0]?.trim();
	const host = forwarded || req.get("host");
	const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
	return new URL(`${proto}://${host}`);
}

function matches(presented: string, expected: string): boolean {
	const actual = Buffer.from(presented);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

/**
 * An iframe navigates by GET and cannot carry a header, so `/resource` takes
 * the key in the query, where the embed's `data-token` already puts it.
 */
function presentedKey(req: Request): string {
	const header = req.get("authorization");
	if (header?.startsWith("Bearer ")) return header.slice(7);
	const query = req.method === "GET" && req.path === "/resource" ? req.query.token : undefined;
	return typeof query === "string" ? query : "";
}

function rateLimit(): RequestHandler {
	const windows = new Map<string, { count: number; resetAt: number }>();
	return (req, res, next) => {
		const now = Date.now();
		const client = req.ip ?? "unknown";
		const open = windows.get(client);
		if (!open || open.resetAt <= now) {
			// Sweeping on the way in keeps the map at one window's worth of clients.
			for (const [seen, window] of windows) {
				if (window.resetAt <= now) windows.delete(seen);
			}
			windows.set(client, { count: 1, resetAt: now + WINDOW_MS });
			next();
			return;
		}
		open.count += 1;
		if (open.count > WINDOW_REQUESTS) {
			res.status(429).json({ error: "rate_limited" });
			return;
		}
		next();
	};
}

/** Whether the runtime would supply the session id to this tool. */
function declaresSessionId(schema: unknown): boolean {
	const properties = (schema as { properties?: unknown } | undefined)?.properties;
	return (
		typeof properties === "object" &&
		properties !== null &&
		"sessionId" in properties
	);
}

/** The last user message's text, which is what the embed posts. */
function requestedMessage(body: unknown): string | undefined {
	const { messages } = (body ?? {}) as { messages?: Array<{ role?: string; parts?: unknown }> };
	const last = Array.isArray(messages) ? messages.at(-1) : undefined;
	if (last?.role !== "user" || !Array.isArray(last.parts)) return undefined;
	return last.parts
		.filter(
			(part): part is { text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n");
}

function widgetContext(req: Request, sessionId: string, source: string): WidgetContext {
	return {
		endpoint: `${publicOrigin(req).origin}${req.baseUrl}/events`,
		sessionId,
		source,
	};
}

function stampWidgets(
	context: WidgetContext,
): TransformStream<UIMessageChunk, UIMessageChunk> {
	return new TransformStream<UIMessageChunk, UIMessageChunk>({
		transform(chunk, controller) {
			controller.enqueue(
				chunk.type === "tool-output-available"
					? { ...chunk, output: withWidgetContext(chunk.output, context) }
					: chunk,
			);
		},
	});
}

/** Runs one operation against this same process's `/mcp` route. */
async function withMcp<T>(
	url: string,
	origin: URL,
	operation: (client: McpClient) => Promise<T>,
): Promise<T> {
	const client = new McpClient({ name: "waniwani-agent-adapter", version: "1" });
	const headers = {
		"x-forwarded-host": origin.host,
		"x-forwarded-proto": origin.protocol.replace(":", ""),
	};
	try {
		await client.connect(
			new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }),
		);
		return await operation(client);
	} finally {
		await client.close();
	}
}

async function pipe(frames: ReadableStream<Uint8Array>, res: Response): Promise<void> {
	const reader = frames.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || res.writableEnded) break;
			res.write(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		if (!res.writableEnded) res.end();
	}
}

/**
 * The `/agent/v1` routes an MCP server mounts beside its own `/mcp`. Browsers
 * present the environment's public key; the router presents the environment
 * key to the runtime, never the other way round.
 */
export function agentRouter(options: AgentRouterOptions): Router {
	const { eveUrl, apiKey, publicKey, allowedOrigins, title, mcpLoopbackUrl } = options;
	const apiUrl = process.env.WANIWANI_API_URL || "https://app.waniwani.ai";
	const router = express.Router();

	// The embed reads the session id off the response to continue and cancel the
	// conversation, and it is on another origin, so the header has to be exposed.
	router.use(cors({ origin: allowedOrigins, exposedHeaders: ["x-session-id"] }));
	router.use(rateLimit());

	router.use((req, res, next) => {
		if (!matches(presentedKey(req), publicKey)) {
			res.status(401).json({ error: "unauthorized" });
			return;
		}
		next();
	});

	router.use((req, res, next) => {
		if (req.method === "GET" || req.method === "HEAD") {
			next();
			return;
		}
		const origin = req.get("origin");
		if (!origin || !allowedOrigins.includes(origin)) {
			res.status(403).json({ error: "forbidden_origin" });
			return;
		}
		next();
	});

	router.use(express.json({ limit: BODY_LIMIT }));

	router.post("/", async (req, res, next) => {
		const message = requestedMessage(req.body);
		const requested: unknown = (req.body as { sessionId?: unknown })?.sessionId;
		if (!message?.trim()) {
			res.status(400).json({ error: "message_required" });
			return;
		}
		if (requested !== undefined && typeof requested !== "string") {
			res.status(400).json({ error: "invalid_session_id" });
			return;
		}

		// Registered before the first await on the runtime, so a browser that gives
		// up while the turn is still opening still cancels it. `close` also fires on
		// a response that ended by itself, hence `finished`.
		const abort = new AbortController();
		let closed = false;
		let finished = false;
		let open: string | undefined;
		const stop = (): void => {
			if (finished || !open) return;
			void cancelTurn({ eveUrl, credential: apiKey, sessionId: open }).catch(() => {});
		};
		res.on("close", () => {
			closed = true;
			abort.abort();
			stop();
		});

		try {
			const turn = await runTurn({
				eveUrl,
				credential: apiKey,
				visitorId: "anonymous",
				message,
				...(requested ? { sessionId: requested } : {}),
				signal: abort.signal,
			});
			open = turn.sessionId;
			if (closed) {
				stop();
				return;
			}

			res.setHeader("content-type", "text/event-stream");
			res.setHeader("cache-control", "no-cache, no-transform");
			res.setHeader("x-vercel-ai-ui-message-stream", "v1");
			res.setHeader("x-session-id", turn.sessionId);
			res.flushHeaders();
			const context = widgetContext(req, turn.sessionId, title);
			await pipe(encodeSse(turn.chunks.pipeThrough(stampWidgets(context))), res);
			finished = true;
		} catch (error) {
			next(error);
		}
	});

	router.post("/cancel", async (req, res, next) => {
		const sessionId: unknown = (req.body as { sessionId?: unknown })?.sessionId;
		if (typeof sessionId !== "string" || !sessionId) {
			res.status(400).json({ error: "session_id_required" });
			return;
		}
		try {
			await cancelTurn({ eveUrl, credential: apiKey, sessionId });
			res.json({ ok: true });
		} catch (error) {
			next(error);
		}
	});

	// Display fields only. The SDK reads a null as "keep your own default".
	router.get("/config", (_req, res) => {
		res.json({
			title,
			welcomeMessage: null,
			placeholder: null,
			suggestions: null,
			enableThreadHistory: true,
			toolCallDisplay: "full",
			debug: false,
			eval: false,
		});
	});

	router.get("/tools", async (req, res, next) => {
		try {
			const origin = publicOrigin(req);
			const { tools } = await withMcp(mcpLoopbackUrl, origin, (mcp) => mcp.listTools());
			res.json({ tools });
		} catch (error) {
			next(error);
		}
	});

	router.post("/tool", async (req, res, next) => {
		const { name, arguments: args } = (req.body ?? {}) as {
			name?: unknown;
			arguments?: Record<string, unknown>;
		};
		const sessionId = req.get("x-session-id");
		try {
			const result = await withMcp(mcpLoopbackUrl, publicOrigin(req), async (mcp) => {
				const { tools } = await mcp.listTools();
				const tool =
					typeof name === "string"
						? tools.find((candidate) => candidate.name === name)
						: undefined;
				if (!tool) return undefined;
				// A strict schema rejects a property it never declared, so the session
				// id goes only where the runtime would put it too.
				const wantsSessionId = sessionId && declaresSessionId(tool.inputSchema);
				return await mcp.callTool({
					name: tool.name,
					arguments: { ...args, ...(wantsSessionId ? { sessionId } : {}) },
				});
			});
			if (!result) {
				res.status(404).json({ error: "unknown_tool" });
				return;
			}
			res.json(withWidgetContext(result, widgetContext(req, sessionId ?? "", title)));
		} catch (error) {
			next(error);
		}
	});

	router.get("/resource", async (req, res, next) => {
		const uri = req.query.uri;
		if (typeof uri !== "string" || !VIEW_RESOURCE.test(uri)) {
			res.status(400).json({ error: "unsupported_resource" });
			return;
		}
		try {
			const origin = publicOrigin(req);
			const resource = await withMcp(mcpLoopbackUrl, origin, (mcp) =>
				mcp.readResource({ uri }),
			);
			const content = resource.contents[0];
			const html = !content
				? undefined
				: "text" in content
					? String(content.text)
					: Buffer.from(String(content.blob), "base64").toString("utf8");
			if (!html) {
				res.status(404).json({ error: "unknown_resource" });
				return;
			}
			res.setHeader("cache-control", "no-store");
			res.type("html").send(/^\s*<!doctype/i.test(html) ? html : `<!doctype html>\n${html}`);
		} catch (error) {
			next(error);
		}
	});

	router.post("/events", async (req, res, next) => {
		const events: unknown = (req.body as { events?: unknown })?.events;
		if (!Array.isArray(events) || events.length > MAX_EVENTS) {
			res.status(400).json({ error: "events_required" });
			return;
		}
		try {
			const upstream = await fetch(`${apiUrl}/api/mcp/events/v2/batch`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${publicKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(req.body),
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			});
			res.status(upstream.status).type("json").send(await upstream.text());
		} catch (error) {
			next(error);
		}
	});

	router.get("/health", async (_req, res, next) => {
		try {
			res.json({ ok: true, runtime: await runtimeHealth({ eveUrl, credential: apiKey }) });
		} catch (error) {
			next(error);
		}
	});

	const onError: ErrorRequestHandler = (error, _req, res, _next) => {
		console.error("[agent]", error instanceof Error ? error.message : "unknown error");
		if (res.headersSent) {
			res.end();
			return;
		}
		// The runtime answers 409 for a session it will not take a turn on, which
		// is also what it says about a session it has never heard of.
		if (error instanceof EveError && error.status >= 400 && error.status < 500) {
			res.status(error.status).json({ error: "session_unavailable" });
			return;
		}
		res.status(502).json({ error: "agent_request_failed" });
	};
	router.use(onError);

	return router;
}
