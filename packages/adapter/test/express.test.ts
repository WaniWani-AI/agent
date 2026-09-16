import type { Server } from "node:http";
import { afterAll, expect, test } from "bun:test";
import express from "express";
import { type AgentRouterOptions, agentRouter } from "../src/express.js";

const PUBLIC_KEY = "wwp_test_public_key";
const ORIGIN = "https://shop.example";
/** Nothing listens here: every assertion below settles before the runtime is reached. */
const UNREACHABLE = "http://127.0.0.1:1";

// `/events` forwards to WaniWani, and the default is the production region.
process.env.WANIWANI_API_URL = UNREACHABLE;

const running: Server[] = [];

async function mount(overrides: Partial<AgentRouterOptions> = {}): Promise<string> {
	const app = express();
	app.use(
		"/agent/v1",
		agentRouter({
			eveUrl: UNREACHABLE,
			apiKey: "wwk_test",
			publicKey: PUBLIC_KEY,
			allowedOrigins: [ORIGIN],
			title: "Fixture",
			mcpLoopbackUrl: `${UNREACHABLE}/mcp`,
			...overrides,
		}),
	);
	const server = app.listen(0);
	running.push(server);
	await new Promise((resolve) => server.once("listening", resolve));
	const { port } = server.address() as { port: number };
	return `http://127.0.0.1:${port}/agent/v1`;
}

afterAll(() => {
	for (const server of running) server.close();
});

test("a browser without the public key is refused", async () => {
	const base = await mount();

	const missing = await fetch(`${base}/config`);
	expect(missing.status).toBe(401);
	expect(await missing.json()).toEqual({ error: "unauthorized" });

	const wrong = await fetch(`${base}/config`, {
		headers: { authorization: "Bearer wwp_somebody_elses_key" },
	});
	expect(wrong.status).toBe(401);
});

test("the public key opens the display config", async () => {
	const base = await mount();
	const response = await fetch(`${base}/config`, {
		headers: { authorization: `Bearer ${PUBLIC_KEY}` },
	});

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		title: "Fixture",
		welcomeMessage: null,
		placeholder: null,
		suggestions: null,
		enableThreadHistory: true,
		toolCallDisplay: "full",
		debug: false,
		eval: false,
	});
});

test("only /resource takes the key in the query, the way an iframe must", async () => {
	const base = await mount();

	// The key was accepted; the missing `uri` is what earns the 400.
	const iframe = await fetch(`${base}/resource?token=${PUBLIC_KEY}`);
	expect(iframe.status).toBe(400);
	expect(await iframe.json()).toEqual({ error: "unsupported_resource" });

	expect((await fetch(`${base}/resource?token=nope`)).status).toBe(401);
	expect((await fetch(`${base}/config?token=${PUBLIC_KEY}`)).status).toBe(401);
});

test("a post has to come from an allowed origin", async () => {
	const base = await mount();
	const post = (origin?: string): Promise<globalThis.Response> =>
		fetch(base, {
			method: "POST",
			headers: {
				authorization: `Bearer ${PUBLIC_KEY}`,
				"content-type": "application/json",
				...(origin ? { origin } : {}),
			},
			body: JSON.stringify({ messages: [] }),
		});

	expect((await post()).status).toBe(403);
	expect((await post("https://attacker.example")).status).toBe(403);
	// Past the origin check, and refused for carrying no user message.
	expect((await post(ORIGIN)).status).toBe(400);
});

test("a client gets sixty requests a minute", async () => {
	const base = await mount();
	const get = (): Promise<globalThis.Response> =>
		fetch(`${base}/config`, { headers: { authorization: `Bearer ${PUBLIC_KEY}` } });

	for (let request = 1; request <= 60; request += 1) {
		expect((await get()).status).toBe(200);
	}

	const refused = await get();
	expect(refused.status).toBe(429);
	expect(await refused.json()).toEqual({ error: "rate_limited" });
});

test("a router without both credentials refuses to exist", () => {
	const options = {
		eveUrl: UNREACHABLE,
		apiKey: "wwk_test",
		publicKey: PUBLIC_KEY,
		allowedOrigins: [ORIGIN],
		title: "Fixture",
		mcpLoopbackUrl: `${UNREACHABLE}/mcp`,
	};

	// An empty key would otherwise compare equal to the empty one a request
	// carrying no key presents.
	expect(() => agentRouter({ ...options, publicKey: "" })).toThrow();
	expect(() => agentRouter({ ...options, apiKey: "" })).toThrow();
});

test("a widget posts from the origin this router serves it on", async () => {
	const base = await mount();
	const self = new URL(base).origin;

	const posted = await fetch(`${base}/events`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${PUBLIC_KEY}`,
			"content-type": "application/json",
			origin: self,
		},
		body: JSON.stringify({ events: [] }),
	});

	// Past the origin check, and only the unreachable app behind it fails.
	expect(posted.status).not.toBe(403);
	expect(posted.status).toBe(502);
});

test("a turn whose stream dies is cancelled on the runtime", async () => {
	const cancelled: string[] = [];
	const runtime = Bun.serve({
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			if (pathname === "/eve/v1/session") {
				return Response.json({ ok: true, sessionId: "wrun_dies" });
			}
			if (pathname.endsWith("/cancel")) {
				cancelled.push(pathname);
				return Response.json({ ok: true, status: "no_active_turn" });
			}
			// Half an answer, then a body that ends with the turn still running.
			return new Response('{"type":"message.appended","data":{"messageDelta":"half"}}\n', {
				headers: { "content-type": "application/x-ndjson" },
			});
		},
	});

	try {
		const base = await mount({ eveUrl: `http://127.0.0.1:${runtime.port}` });
		const response = await fetch(base, {
			method: "POST",
			headers: {
				authorization: `Bearer ${PUBLIC_KEY}`,
				"content-type": "application/json",
				origin: ORIGIN,
			},
			body: JSON.stringify({
				messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
			}),
		});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain('"finishReason":"error"');

		// The close handler runs once the response is off the wire.
		for (let attempt = 0; attempt < 40 && cancelled.length === 0; attempt += 1) {
			await Bun.sleep(25);
		}
		expect(cancelled).toEqual(["/eve/v1/session/wrun_dies/cancel"]);
	} finally {
		runtime.stop(true);
	}
});
