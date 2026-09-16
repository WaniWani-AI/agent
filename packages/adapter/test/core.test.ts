import { expect, test } from "bun:test";
import { jwtVerify } from "jose";
import { encodeSse, mintSessionToken, runTurn } from "../src/core.js";
import type { UIMessageChunk } from "../src/ui-stream.js";

const SECRET = "ci-agent-secret";

async function claims(token: string): Promise<Record<string, unknown>> {
	const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET), {
		audience: "waniwani-agent-runtime",
		issuer: "waniwani:agent",
	});
	return payload as Record<string, unknown>;
}

function chunks(values: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
	return new ReadableStream({
		start(controller) {
			for (const value of values) controller.enqueue(value);
			controller.close();
		},
	});
}

test("mints a session token the runtime's channel verifies", async () => {
	const token = await mintSessionToken({
		secret: SECRET,
		sub: "visitor-42",
		environmentId: "11111111-1111-4111-8111-111111111111",
		channelId: "33333333-3333-4333-8333-333333333333",
		sid: "wrun_abc",
	});

	const [header] = token.split(".");
	expect(JSON.parse(Buffer.from(String(header), "base64url").toString()).alg).toBe("HS256");

	const payload = await claims(token);
	expect(payload.sub).toBe("visitor-42");
	expect(payload.environmentId).toBe("11111111-1111-4111-8111-111111111111");
	expect(payload.channelId).toBe("33333333-3333-4333-8333-333333333333");
	expect(payload.sid).toBe("wrun_abc");
	expect(typeof payload.jti).toBe("string");
	expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
});

test("leaves out the claims it was not given", async () => {
	const payload = await claims(
		await mintSessionToken({ secret: SECRET, sub: "anonymous" }),
	);
	expect(payload.sub).toBe("anonymous");
	expect("environmentId" in payload).toBe(false);
	expect("channelId" in payload).toBe(false);
	expect("sid" in payload).toBe(false);
});

test("mints a different jti every time", async () => {
	const one = await claims(await mintSessionToken({ secret: SECRET, sub: "anonymous" }));
	const two = await claims(await mintSessionToken({ secret: SECRET, sub: "anonymous" }));
	expect(one.jti).not.toBe(two.jti);
});

test("frames chunks as server-sent events and terminates the stream", async () => {
	const frames = await new Response(
		encodeSse(chunks([{ type: "start" }, { type: "finish", finishReason: "stop" }])),
	).text();

	expect(frames).toBe(
		'data: {"type":"start"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n\n',
	);
});

test("turns a transport failure into an error chunk and still terminates", async () => {
	let started = false;
	const failing = new ReadableStream<UIMessageChunk>({
		pull(controller) {
			if (started) {
				controller.error(new Error("stream disconnected"));
				return;
			}
			started = true;
			controller.enqueue({ type: "start" });
		},
	});

	const frames = (await new Response(encodeSse(failing)).text()).split("\n\n").filter(Boolean);
	expect(frames[0]).toBe('data: {"type":"start"}');
	expect(frames[1]).toBe('data: {"type":"error","errorText":"stream disconnected"}');
	expect(frames[2]).toBe('data: {"type":"finish","finishReason":"error"}');
	expect(frames[3]).toBe("data: [DONE]");
});

test("a stream that stops mid-turn reaches the browser as a failure", async () => {
	// A turn that streams one delta and then ends its body with no boundary
	// behind it, which is what a proxy closing a connection looks like.
	const runtime = Bun.serve({
		port: 0,
		fetch(request) {
			if (new URL(request.url).pathname === "/eve/v1/session") {
				return Response.json({ ok: true, sessionId: "wrun_partial" });
			}
			return new Response(
				'{"type":"message.appended","data":{"messageDelta":"half an "}}\n',
				{ headers: { "content-type": "application/x-ndjson" } },
			);
		},
	});

	try {
		const turn = await runTurn({
			eveUrl: `http://127.0.0.1:${runtime.port}`,
			credential: "wwk_test",
			message: "hello",
		});
		expect(turn.sessionId).toBe("wrun_partial");

		const frames = (await new Response(encodeSse(turn.chunks)).text())
			.split("\n\n")
			.filter(Boolean);
		expect(frames.some((frame) => frame.includes('"delta":"half an "'))).toBe(true);
		expect(frames.some((frame) => frame.includes('"type":"error"'))).toBe(true);
		expect(frames.at(-2)).toBe('data: {"type":"finish","finishReason":"error"}');
		expect(frames.at(-1)).toBe("data: [DONE]");
	} finally {
		runtime.stop(true);
	}
});
