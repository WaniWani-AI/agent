import { createPrivateKey, sign } from "node:crypto";
import type { SessionAuth } from "eve/context";

export const SELF_TENANT = "self";
export const ANONYMOUS = "anonymous";

const SERVICE_ISSUER = "waniwani:agent-runtime";
const SERVICE_TOKEN_LIFETIME_SECONDS = 60;

export type Tenant = { key: string; environmentId?: string };

/** Which credential this deployment accepts, decided once by the environment. */
export type CredentialForm = "self-hosted" | "hosted";

export function credentialForm(): CredentialForm {
	const selfHosted = Boolean(process.env.WANIWANI_API_KEY);
	const hosted = Boolean(process.env.WANIWANI_AGENT_SECRET);
	if (selfHosted === hosted) {
		throw new Error(
			"Set exactly one of WANIWANI_API_KEY (self-hosted) and WANIWANI_AGENT_SECRET (hosted)",
		);
	}
	return selfHosted ? "self-hosted" : "hosted";
}

function attribute(
	auth: SessionAuth | undefined,
	name: string,
): string | undefined {
	const value = auth?.initiator?.attributes[name];
	return typeof value === "string" && value ? value : undefined;
}

export function tenantOf(auth: SessionAuth | undefined): Tenant {
	const environmentId = attribute(auth, "environmentId");

	if (credentialForm() === "self-hosted") {
		if (environmentId) {
			throw new Error(
				"Session credential names an environment, and WANIWANI_API_KEY serves only its own",
			);
		}
		return { key: SELF_TENANT };
	}
	if (!environmentId) {
		throw new Error(
			"Session credential names no environment, and WANIWANI_AGENT_SECRET requires one",
		);
	}
	return { key: environmentId, environmentId };
}

/**
 * The channel a turn is attributed to. Hosted deployments carry it per visitor,
 * self-hosted ones configure it once, and either way it has to be a channel the
 * environment actually published.
 */
export function resolveChannel(input: {
	auth: SessionAuth | undefined;
	channels: readonly { id: string; label: string | null }[];
}): { id: string; label: string | null } | undefined {
	if (credentialForm() === "hosted") {
		const claimed = attribute(input.auth, "channelId");
		return claimed
			? (input.channels.find((entry) => entry.id === claimed) ?? {
					id: claimed,
					label: null,
				})
			: input.channels[0];
	}

	const configured = process.env.WANIWANI_CHANNEL_ID;
	if (!configured) {
		return input.channels[0];
	}
	const found = input.channels.find((entry) => entry.id === configured);
	if (!found) {
		throw new Error(
			`WANIWANI_CHANNEL_ID ${configured} is not a channel of this environment`,
		);
	}
	return found;
}

/**
 * eve authenticates every session-addressed route but authorizes none of them,
 * so a token valid for one environment can post into another environment's
 * session, which resolves against the initiator's tenant.
 */
export function assertCallerOwnsSession(auth: SessionAuth | undefined): void {
	const { current, initiator } = auth ?? { current: null, initiator: null };
	if (!current || !initiator || current === initiator) {
		return;
	}

	const currentEnvironment = current.attributes.environmentId;
	const initiatorEnvironment = initiator.attributes.environmentId;
	if (currentEnvironment !== initiatorEnvironment) {
		throw new Error(
			"Session token names a different environment than the session it addresses",
		);
	}

	// A session's visitor is fixed when it is created, because `_meta.visitorId`
	// and every analytics event read the initiator. Signing in starts a new one.
	if (current.subject !== initiator.subject) {
		throw new Error(
			"Session token names a different visitor than the session it addresses",
		);
	}
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
