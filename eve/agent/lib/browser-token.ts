import type { SessionAuthContext } from "eve/context";
import { verifyJwtHmac } from "eve/channels/auth";

export const BROWSER_AUDIENCE = "waniwani-agent-browser";
export const NATIVE_TRANSPORT = "eve-native";

type BrowserOperation = "send" | "stream" | "cancel";

const SESSION_ROUTE = /^\/eve\/v1\/session\/([^/]+)(\/stream|\/cancel)?\/?$/;

/**
 * The only operations a browser token reaches: a message or approval answer to
 * its own session, that session's stream, and cancelling its active turn.
 * Creating, listing, clearing, compacting and resetting stay server-only.
 */
export function browserOperation(request: Request, sessionId: string): BrowserOperation | undefined {
	const match = SESSION_ROUTE.exec(new URL(request.url).pathname);
	if (!match?.[1] || decodeURIComponent(match[1]) !== sessionId) return undefined;
	const suffix = match[2];
	if (request.method === "POST" && suffix === undefined) return "send";
	if (request.method === "GET" && suffix === "/stream") return "stream";
	if (request.method === "POST" && suffix === "/cancel") return "cancel";
	return undefined;
}

export async function verifyBrowserToken(input: {
	token: string | null;
	request: Request;
	secret: string;
}): Promise<SessionAuthContext | null> {
	const verified = await verifyJwtHmac(input.token, {
		algorithm: "HS256",
		audiences: [BROWSER_AUDIENCE],
		issuer: "waniwani:agent",
		secret: input.secret,
		claims: { purpose: ["browser"], transport: [NATIVE_TRANSPORT] },
	});
	if (!verified.ok) return null;
	const { attributes } = verified.sessionAuth;

	const sessionId = attributes.sid;
	if (typeof sessionId !== "string" || typeof attributes.environmentId !== "string") return null;
	if (!browserOperation(input.request, sessionId)) return null;

	const region = process.env.WANIWANI_REGION;
	if (region && attributes.region !== region) return null;

	// A supplement to the token, which is what authorizes: a script sends no Origin.
	const origin = input.request.headers.get("origin");
	if (origin && typeof attributes.origin === "string" && origin !== attributes.origin) return null;

	return verified.sessionAuth;
}

export function isNativeSession(auth: { initiator: SessionAuthContext | null } | undefined): boolean {
	return auth?.initiator?.attributes.transport === NATIVE_TRANSPORT;
}
