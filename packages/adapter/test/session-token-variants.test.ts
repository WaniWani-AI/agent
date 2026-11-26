import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { decodeJwt, jwtVerify } from "jose";
import { mintSessionToken } from "../src/core.js";

const APP_KEYS = generateKeyPairSync("ec", { namedCurve: "P-256" });
const SIGNING_KEY = APP_KEYS.privateKey
	.export({ type: "pkcs8", format: "pem" })
	.toString();

const ENVIRONMENT = "11111111-1111-4111-8111-111111111111";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const TUNNEL = "https://dev-maxime.waniwani.dev/mcp";

const STANDARD_CLAIMS = ["aud", "exp", "iat", "iss", "jti", "sub"];

async function claims(token: string): Promise<Record<string, unknown>> {
	const { payload } = await jwtVerify(token, APP_KEYS.publicKey, {
		algorithms: ["ES256"],
		audience: "waniwani-agent-runtime",
		issuer: "waniwani:agent",
	});
	return { ...payload };
}

function claimNames(payload: Record<string, unknown>): string[] {
	return Object.keys(payload).sort();
}

test("a draft token carries config=draft and the claims it carried before", async () => {
	const payload = await claims(
		await mintSessionToken({
			signingKey: SIGNING_KEY,
			sub: "dashboard-user",
			environmentId: ENVIRONMENT,
			channelId: CHANNEL,
			sid: "wrun_draft",
			config: "draft",
		}),
	);

	expect(payload.config).toBe("draft");
	expect(payload.environmentId).toBe(ENVIRONMENT);
	expect(payload.channelId).toBe(CHANNEL);
	expect(payload.sid).toBe("wrun_draft");
	expect("mcpUrl" in payload).toBe(false);
});

test("a tunnel token carries the tunnel URL verbatim and no config claim", async () => {
	const url = "https://dev-1.waniwani.dev/mcp?x=1&y=a%20b#frag";
	const payload = await claims(
		await mintSessionToken({
			signingKey: SIGNING_KEY,
			sub: "developer",
			environmentId: ENVIRONMENT,
			mcpUrl: url,
		}),
	);

	expect(payload.mcpUrl).toBe(url);
	expect("config" in payload).toBe(false);
});

test("a token can carry both a draft and a tunnel", async () => {
	const payload = await claims(
		await mintSessionToken({
			signingKey: SIGNING_KEY,
			sub: "developer",
			environmentId: ENVIRONMENT,
			config: "draft",
			mcpUrl: TUNNEL,
		}),
	);

	expect(payload.config).toBe("draft");
	expect(payload.mcpUrl).toBe(TUNNEL);
});

test("a live token keeps exactly the claim set it had before the variants existed", async () => {
	const full = await claims(
		await mintSessionToken({
			signingKey: SIGNING_KEY,
			sub: "visitor-42",
			environmentId: ENVIRONMENT,
			channelId: CHANNEL,
			sid: "wrun_abc",
		}),
	);
	expect(claimNames(full)).toEqual(
		[...STANDARD_CLAIMS, "channelId", "environmentId", "sid"].sort(),
	);

	const bare = await claims(
		await mintSessionToken({ signingKey: SIGNING_KEY, sub: "anonymous" }),
	);
	expect(claimNames(bare)).toEqual([...STANDARD_CLAIMS].sort());
});

test("explicitly undefined variant inputs put no claim on the token", async () => {
	const payload = await claims(
		await mintSessionToken({
			signingKey: SIGNING_KEY,
			sub: "visitor-42",
			environmentId: ENVIRONMENT,
			config: undefined,
			mcpUrl: undefined,
		}),
	);

	expect("config" in payload).toBe(false);
	expect("mcpUrl" in payload).toBe(false);
	expect(claimNames(payload)).toEqual(
		[...STANDARD_CLAIMS, "environmentId"].sort(),
	);
});

test("an empty tunnel URL puts no claim on the token", async () => {
	const payload = await claims(
		await mintSessionToken({
			signingKey: SIGNING_KEY,
			sub: "visitor-42",
			environmentId: ENVIRONMENT,
			mcpUrl: "",
		}),
	);

	expect("mcpUrl" in payload).toBe(false);
	expect(claimNames(payload)).toEqual(
		[...STANDARD_CLAIMS, "environmentId"].sort(),
	);
});

test("an empty config from an untyped caller puts no claim on the token", async () => {
	const untyped: { config?: "draft" } = JSON.parse('{"config":""}');
	const payload = await claims(
		await mintSessionToken({
			signingKey: SIGNING_KEY,
			sub: "visitor-42",
			environmentId: ENVIRONMENT,
			...untyped,
		}),
	);

	expect("config" in payload).toBe(false);
	expect(claimNames(payload)).toEqual(
		[...STANDARD_CLAIMS, "environmentId"].sort(),
	);
});

test("the variant claims ride in the payload, never in the protected header", async () => {
	const token = await mintSessionToken({
		signingKey: SIGNING_KEY,
		sub: "developer",
		environmentId: ENVIRONMENT,
		config: "draft",
		mcpUrl: TUNNEL,
	});
	const [header] = token.split(".");
	const decodedHeader = JSON.parse(
		Buffer.from(String(header), "base64url").toString(),
	);

	expect(decodedHeader).toEqual({ alg: "ES256" });
	expect(decodeJwt(token).config).toBe("draft");
});

test("a variant token keeps the same five-minute lifetime as a live one", async () => {
	const payload = await claims(
		await mintSessionToken({
			signingKey: SIGNING_KEY,
			sub: "developer",
			environmentId: ENVIRONMENT,
			config: "draft",
			mcpUrl: TUNNEL,
		}),
	);

	expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
});
