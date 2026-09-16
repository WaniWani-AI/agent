import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { agentRouter } from "../dist/express.js";

// Exercise a real peer disconnect under the production Node runtime. Bun's
// Node HTTP shim does not reliably emit ServerResponse.close for streaming peers.
test("closing an old browser response cannot cancel the replacement turn", { timeout: 10_000 }, async () => {
	let active = "turn_b";
	let recordCancel;
	let deadline;
	const cancellation = new Promise((resolve) => { recordCancel = resolve; });
	const runtime = createServer(async (request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.url.endsWith("/cancel")) {
			let body = "";
			for await (const chunk of request) body += chunk;
			const parsed = JSON.parse(body);
			if (!parsed.turnId || parsed.turnId === active) active = "cancelled";
			response.end('{"ok":true}');
			recordCancel(parsed);
		} else if (request.method === "POST") {
			response.end('{"sessionId":"session"}');
		} else {
			response.setHeader("content-type", "application/x-ndjson");
			response.write(JSON.stringify({ type: "message.appended", data: { turnId: "turn_a", messageDelta: "A" } }) + "\n");
			// The old connection lingers even though B is now the runtime's active turn.
		}
	});
	runtime.listen(0, "127.0.0.1");
	await once(runtime, "listening");
	const app = express();
	app.use("/agent", agentRouter({
		eveUrl: `http://127.0.0.1:${runtime.address().port}`,
		apiKey: "wwk_test", publicKey: "wwp_test", allowedOrigins: ["https://shop.example"],
		title: "Fixture", mcpLoopbackUrl: "http://127.0.0.1:1/mcp",
	}));
	const server = app.listen(0, "127.0.0.1");
	await once(server, "listening");
	const abort = new AbortController();
	try {
		const response = await fetch(`http://127.0.0.1:${server.address().port}/agent`, {
			method: "POST", signal: abort.signal,
			headers: { authorization: "Bearer wwp_test", "content-type": "application/json", origin: "https://shop.example" },
			body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text: "A" }] }] }),
		});
		assert.equal(response.status, 200);
		const reader = response.body.getReader();
		let received = "";
		while (!received.includes('"delta":"A"')) {
			const next = await reader.read();
			assert.equal(next.done, false);
			received += new TextDecoder().decode(next.value);
		}
		abort.abort();
		await reader.cancel().catch(() => {});
		const cancelled = await Promise.race([
			cancellation,
			new Promise((_, reject) => {
				deadline = setTimeout(() => reject(new Error("Disconnect did not cancel its turn")), 5_000);
			}),
		]);
		assert.deepEqual(cancelled, { turnId: "turn_a" });
		assert.equal(active, "turn_b");
	} finally {
		clearTimeout(deadline);
		abort.abort();
		server.closeAllConnections();
		runtime.closeAllConnections();
		await Promise.all([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => runtime.close(resolve))]);
	}
});
