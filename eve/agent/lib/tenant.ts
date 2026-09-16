import { createPrivateKey, sign } from "node:crypto";
import type { SessionAuth } from "eve/context";

export const SELF_TENANT = "self";

const SERVICE_ISSUER = "waniwani:agent-runtime";
const SERVICE_TOKEN_LIFETIME_SECONDS = 60;

export type Tenant = { key: string; environmentId?: string };

function attribute(
	auth: SessionAuth | undefined,
	name: string,
): string | undefined {
	const value = auth?.initiator?.attributes[name];
	return typeof value === "string" && value ? value : undefined;
}

export function tenantOf(auth: SessionAuth | undefined): Tenant {
	const environmentId = attribute(auth, "environmentId");
	const hosted = Boolean(process.env.WANIWANI_SERVICE_PRIVATE_KEY);

	if (environmentId && !hosted) {
		throw new Error(
			"Session token names an environment, but this runtime authenticates with WANIWANI_API_KEY and can only serve its own",
		);
	}
	if (!environmentId && hosted) {
		throw new Error(
			"Session token names no environment, and this runtime authenticates with WANIWANI_SERVICE_PRIVATE_KEY, which needs one",
		);
	}
	return environmentId
		? { key: environmentId, environmentId }
		: { key: SELF_TENANT };
}

export function channelIdOf(auth: SessionAuth | undefined): string | undefined {
	return attribute(auth, "channelId");
}

function base64url(value: Buffer | string): string {
	return Buffer.from(value).toString("base64url");
}

/** Ed25519 signs with a null digest, which is what `EdDSA` means to the app's verifier. */
function serviceToken(): string {
	const pem = process.env.WANIWANI_SERVICE_PRIVATE_KEY;
	const region = process.env.WANIWANI_REGION;
	if (!pem) throw new Error("WANIWANI_SERVICE_PRIVATE_KEY is not set");
	if (!region) throw new Error("WANIWANI_REGION is not set");

	const issuedAt = Math.floor(Date.now() / 1000);
	const header = base64url(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
	const payload = base64url(
		JSON.stringify({
			iss: SERVICE_ISSUER,
			aud: `waniwani:region:${region}`,
			iat: issuedAt,
			exp: issuedAt + SERVICE_TOKEN_LIFETIME_SECONDS,
		}),
	);
	const signature = sign(
		null,
		Buffer.from(`${header}.${payload}`),
		createPrivateKey(pem),
	);
	return `${header}.${payload}.${base64url(signature)}`;
}

export function configRequest(tenant: Tenant): {
	url: string;
	authorization: string;
} {
	const base = process.env.WANIWANI_API_URL || "https://app.waniwani.ai";
	const path = `${base}/api/mcp/agent/config`;

	if (!tenant.environmentId) {
		const apiKey = process.env.WANIWANI_API_KEY;
		if (!apiKey) throw new Error("WANIWANI_API_KEY is not set");
		return { url: path, authorization: `Bearer ${apiKey}` };
	}
	return {
		url: `${path}?environmentId=${encodeURIComponent(tenant.environmentId)}`,
		authorization: `Bearer ${serviceToken()}`,
	};
}
