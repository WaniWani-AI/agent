import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import { browserOperation, isNativeSession, verifyBrowserToken } from "./browser-token.js";

const SECRET = "browser-token-test-secret-0123456789abcdef";
const RUNTIME = "https://runtime.example";
const SID = "sess_abc123";
const SHOP = "https://shop.example";

function b64url(value: string | Buffer): string {
	return Buffer.from(value).toString("base64url");
}

function mint(
	claims: Record<string, unknown>,
	options: { secret?: string; alg?: string; signature?: string } = {},
): string {
	const header = b64url(JSON.stringify({ alg: options.alg ?? "HS256", typ: "JWT" }));
	const payload = b64url(JSON.stringify(claims));
	const signature =
		options.signature ??
		createHmac("sha256", options.secret ?? SECRET).update(`${header}.${payload}`).digest("base64url");
	return `${header}.${payload}.${signature}`;
}

function browserClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		iss: "waniwani:agent",
		aud: "waniwani-agent-browser",
		sub: "visitor_1",
		iat: now,
		exp: now + 300,
		purpose: "browser",
		transport: "eve-native",
		environmentId: "env_1",
		sid: SID,
		channelId: "chan_1",
		region: "us",
		origin: SHOP,
		context: JSON.stringify({ page: "/pricing" }),
		...overrides,
	};
}

function without(claims: Record<string, unknown>, key: string): Record<string, unknown> {
	const copy = { ...claims };
	delete copy[key];
	return copy;
}

function request(method: string, path: string, headers: Record<string, string> = {}): Request {
	return new Request(`${RUNTIME}${path}`, { method, headers });
}

async function verify(token: string, req: Request, secret = SECRET) {
	return await verifyBrowserToken({ token, request: req, secret });
}

let savedRegion: string | undefined;

beforeEach(() => {
	savedRegion = process.env.WANIWANI_REGION;
	process.env.WANIWANI_REGION = "us";
});

afterEach(() => {
	if (savedRegion === undefined) delete process.env.WANIWANI_REGION;
	else process.env.WANIWANI_REGION = savedRegion;
});

describe("verifyBrowserToken: the three allowed operations on its own session", () => {
	test("POST /eve/v1/session/<sid> is accepted", async () => {
		const auth = await verify(mint(browserClaims()), request("POST", `/eve/v1/session/${SID}`));
		expect(auth).not.toBeNull();
		expect(auth?.attributes.sid).toBe(SID);
		expect(auth?.attributes.environmentId).toBe("env_1");
		expect(auth?.attributes.transport).toBe("eve-native");
		expect(auth?.attributes.purpose).toBe("browser");
	});

	test("GET /eve/v1/session/<sid>/stream is accepted", async () => {
		expect(await verify(mint(browserClaims()), request("GET", `/eve/v1/session/${SID}/stream`))).not.toBeNull();
	});

	test("POST /eve/v1/session/<sid>/cancel is accepted", async () => {
		expect(await verify(mint(browserClaims()), request("POST", `/eve/v1/session/${SID}/cancel`))).not.toBeNull();
	});

	test("the token's context and channel claims survive as attributes", async () => {
		const auth = await verify(mint(browserClaims()), request("POST", `/eve/v1/session/${SID}`));
		expect(auth?.attributes.context).toBe(JSON.stringify({ page: "/pricing" }));
		expect(auth?.attributes.channelId).toBe("chan_1");
	});

	test("a query string on an allowed path does not change the answer", async () => {
		expect(
			await verify(mint(browserClaims()), request("GET", `/eve/v1/session/${SID}/stream?startIndex=3`)),
		).not.toBeNull();
	});
});

describe("verifyBrowserToken: routes a browser token never reaches", () => {
	const refused: Array<[string, string]> = [
		["POST", "/eve/v1/session"],
		["POST", "/eve/v1/session/"],
		["POST", `/eve/v1/session/${SID}/clear`],
		["POST", `/eve/v1/session/${SID}/compact`],
		["POST", `/eve/v1/session/${SID}/reset`],
		["GET", "/eve/v1/info"],
		["GET", "/eve/v1/health"],
		["GET", `/eve/v1/session/${SID}`],
		["POST", `/eve/v1/session/${SID}/stream`],
		["GET", `/eve/v1/session/${SID}/cancel`],
		["PUT", `/eve/v1/session/${SID}`],
		["DELETE", `/eve/v1/session/${SID}`],
		["PATCH", `/eve/v1/session/${SID}/cancel`],
		["GET", `/eve/v1/session/${SID}/subagents/call_1/child_1/stream`],
		["POST", `/eve/v1/session/${SID}/stream/extra`],
		["POST", `/other/eve/v1/session/${SID}`],
	];
	for (const [method, path] of refused) {
		test(`${method} ${path} is refused`, async () => {
			expect(await verify(mint(browserClaims()), request(method, path))).toBeNull();
		});
	}

	test("another session id is refused on send", async () => {
		expect(await verify(mint(browserClaims()), request("POST", "/eve/v1/session/sess_other"))).toBeNull();
	});

	test("another session id is refused on stream", async () => {
		expect(await verify(mint(browserClaims()), request("GET", "/eve/v1/session/sess_other/stream"))).toBeNull();
	});

	test("another session id is refused on cancel", async () => {
		expect(await verify(mint(browserClaims()), request("POST", "/eve/v1/session/sess_other/cancel"))).toBeNull();
	});

	test("a session id that only starts with the token's sid is refused", async () => {
		expect(await verify(mint(browserClaims()), request("POST", `/eve/v1/session/${SID}x`))).toBeNull();
	});

	test("a traversal back into another session is refused", async () => {
		expect(
			await verify(mint(browserClaims()), request("POST", `/eve/v1/session/${SID}/../sess_other`)),
		).toBeNull();
	});

	test("an encoded slash that smuggles a sub-route into the id is refused", async () => {
		expect(
			await verify(mint(browserClaims()), request("POST", `/eve/v1/session/${SID}%2Fclear`)),
		).toBeNull();
	});
});

describe("verifyBrowserToken: bad tokens", () => {
	const req = () => request("POST", `/eve/v1/session/${SID}`);

	test("a null token is refused", async () => {
		expect(await verifyBrowserToken({ token: null, request: req(), secret: SECRET })).toBeNull();
	});

	test("an expired token is refused", async () => {
		const now = Math.floor(Date.now() / 1000);
		expect(await verify(mint(browserClaims({ iat: now - 7200, exp: now - 3600 })), req())).toBeNull();
	});

	test("a token signed with another secret is refused", async () => {
		expect(await verify(mint(browserClaims(), { secret: "some-other-secret-value-xyz" }), req())).toBeNull();
	});

	test("a token with a tampered signature is refused", async () => {
		expect(await verify(mint(browserClaims(), { signature: b64url("nope") }), req())).toBeNull();
	});

	test("an unsigned alg:none token is refused", async () => {
		expect(await verify(mint(browserClaims(), { alg: "none", signature: "" }), req())).toBeNull();
	});

	test("the server audience is refused", async () => {
		expect(await verify(mint(browserClaims({ aud: "waniwani-agent-runtime" })), req())).toBeNull();
	});

	test("an unrelated audience is refused", async () => {
		expect(await verify(mint(browserClaims({ aud: "someone-else" })), req())).toBeNull();
	});

	test("the wrong issuer is refused", async () => {
		expect(await verify(mint(browserClaims({ iss: "waniwani:agent-runtime" })), req())).toBeNull();
	});

	test("a purpose other than browser is refused", async () => {
		expect(await verify(mint(browserClaims({ purpose: "server" })), req())).toBeNull();
	});

	test("a token with no purpose claim is refused", async () => {
		expect(await verify(mint(without(browserClaims(), "purpose")), req())).toBeNull();
	});

	test("a transport other than eve-native is refused", async () => {
		expect(await verify(mint(browserClaims({ transport: "app-proxy" })), req())).toBeNull();
	});

	test("a missing sid is refused", async () => {
		expect(await verify(mint(without(browserClaims(), "sid")), req())).toBeNull();
	});

	test("a non-string sid is refused", async () => {
		expect(await verify(mint(browserClaims({ sid: 12345 })), request("POST", "/eve/v1/session/12345"))).toBeNull();
	});

	test("a missing environmentId is refused", async () => {
		expect(await verify(mint(without(browserClaims(), "environmentId")), req())).toBeNull();
	});

	test("an empty environmentId is refused", async () => {
		expect(await verify(mint(browserClaims({ environmentId: "" })), req())).toBeNull();
	});
});

describe("verifyBrowserToken: region", () => {
	const req = () => request("POST", `/eve/v1/session/${SID}`);

	test("a region claim different from WANIWANI_REGION is refused", async () => {
		expect(await verify(mint(browserClaims({ region: "eu" })), req())).toBeNull();
	});

	test("a region claim equal to WANIWANI_REGION is accepted", async () => {
		expect(await verify(mint(browserClaims({ region: "us" })), req())).not.toBeNull();
	});

	test("with WANIWANI_REGION unset, the region claim is not held against the token", async () => {
		delete process.env.WANIWANI_REGION;
		expect(await verify(mint(browserClaims({ region: "eu" })), req())).not.toBeNull();
	});
});

describe("verifyBrowserToken: origin", () => {
	const send = (headers: Record<string, string>) => request("POST", `/eve/v1/session/${SID}`, headers);

	test("an Origin equal to the token's origin is accepted", async () => {
		expect(await verify(mint(browserClaims()), send({ origin: SHOP }))).not.toBeNull();
	});

	test("an Origin different from the token's origin is refused", async () => {
		expect(await verify(mint(browserClaims()), send({ origin: "https://evil.example" }))).toBeNull();
	});

	test("a lookalike Origin that only extends the token's origin is refused", async () => {
		expect(await verify(mint(browserClaims()), send({ origin: `${SHOP}.evil.example` }))).toBeNull();
	});

	test("an Origin on another port of the same host is refused", async () => {
		expect(await verify(mint(browserClaims()), send({ origin: `${SHOP}:8443` }))).toBeNull();
	});

	test("an Origin mismatch is refused on the stream route too", async () => {
		const req = request("GET", `/eve/v1/session/${SID}/stream`, { origin: "https://evil.example" });
		expect(await verify(mint(browserClaims()), req)).toBeNull();
	});

	test("a request without Origin is accepted", async () => {
		expect(await verify(mint(browserClaims()), send({}))).not.toBeNull();
	});
});

describe("browserOperation", () => {
	test("names the three operations", () => {
		expect(browserOperation(request("POST", `/eve/v1/session/${SID}`), SID)).toBe("send");
		expect(browserOperation(request("GET", `/eve/v1/session/${SID}/stream`), SID)).toBe("stream");
		expect(browserOperation(request("POST", `/eve/v1/session/${SID}/cancel`), SID)).toBe("cancel");
	});

	test("an encoded session id matches its decoded form", () => {
		expect(browserOperation(request("POST", "/eve/v1/session/sess%20one"), "sess one")).toBe("send");
	});

	test("nothing for another session", () => {
		expect(browserOperation(request("POST", `/eve/v1/session/${SID}`), "sess_other")).toBeUndefined();
	});

	test("nothing for session creation, clear, compact, reset and info", () => {
		expect(browserOperation(request("POST", "/eve/v1/session"), SID)).toBeUndefined();
		expect(browserOperation(request("POST", `/eve/v1/session/${SID}/clear`), SID)).toBeUndefined();
		expect(browserOperation(request("POST", `/eve/v1/session/${SID}/compact`), SID)).toBeUndefined();
		expect(browserOperation(request("POST", `/eve/v1/session/${SID}/reset`), SID)).toBeUndefined();
		expect(browserOperation(request("GET", "/eve/v1/info"), SID)).toBeUndefined();
	});

	test("a malformed percent-encoding in the id is no operation, and does not throw", () => {
		let result: string | undefined = "threw";
		try {
			result = browserOperation(request("POST", "/eve/v1/session/%E0%A4%A"), SID);
		} catch {
			result = "threw";
		}
		expect(result).toBeUndefined();
	});
});

function context(attributes: Record<string, string>): SessionAuthContext {
	return {
		attributes,
		authenticator: "jwt-hmac",
		principalId: "waniwani:agent:visitor_1",
		principalType: "service",
	};
}

describe("isNativeSession", () => {
	test("true when the initiator carries transport eve-native", () => {
		const native = context({ transport: "eve-native" });
		expect(isNativeSession({ initiator: native })).toBe(true);
	});

	test("false when the initiator carries another transport", () => {
		expect(isNativeSession({ initiator: context({ transport: "app-proxy" }) })).toBe(false);
	});

	test("false when the initiator carries no transport", () => {
		expect(isNativeSession({ initiator: context({}) })).toBe(false);
	});

	test("false when only the current caller is native", () => {
		const auth = { current: context({ transport: "eve-native" }), initiator: context({}) };
		expect(isNativeSession(auth)).toBe(false);
	});

	test("false with no initiator", () => {
		expect(isNativeSession({ initiator: null })).toBe(false);
	});

	test("false with no auth at all", () => {
		expect(isNativeSession(undefined)).toBe(false);
	});
});
