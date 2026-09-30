import { timingSafeEqual } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import { extractBearerToken, verifyJwtEcdsa } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { decodedSegment, verifyBrowserToken } from "../lib/browser-token.js";
import {
	GUARDRAIL_BLOCKED,
	lakeraFlags,
	messageText,
	REFUSAL_CONTEXT,
} from "../lib/guardrail.js";
import { publishedNow } from "../lib/published.js";
import { ANONYMOUS, appPublicKey, credentialForm, tenantOf } from "../lib/tenant.js";

type Attributes = Readonly<Record<string, string | readonly string[]>>;

/** `/eve/v1/session/<id>` and everything under it: stream, cancel, clear, compact, reset. */
const ADDRESSED_SESSION = /^\/eve\/v1\/session\/([^/]+)/;

/** A segment that does not decode addresses no session a token could name, so it matches none. */
function addressedSession(request: Request): string | null | undefined {
	const match = ADDRESSED_SESSION.exec(new URL(request.url).pathname);
	return match?.[1] ? (decodedSegment(match[1]) ?? null) : undefined;
}

function matches(token: string | null, expected: string): boolean {
	const actual = Buffer.from(token ?? "");
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function withBackendHeaders(request: Request, attributes: Attributes): Attributes {
	const extra = request.headers.get("x-waniwani-extra");
	const context = request.headers.get("x-waniwani-context");
	return {
		...attributes,
		...(extra ? { extra } : {}),
		...(context ? { context } : {}),
	};
}

/** The app reads a hosted environment's config only for a caller holding a live token for it. */
function withGrant(auth: SessionAuthContext, token: string | null): SessionAuthContext {
	return token ? { ...auth, attributes: { ...auth.attributes, grant: token } } : auth;
}

async function guarded(caller: SessionAuthContext, text: string) {
	if (caller.attributes.purpose !== "browser") return { auth: caller };
	const instructions = await publishedNow(tenantOf({ current: caller, initiator: caller }))
		.then((published) => published.config.instructions)
		.catch(() => undefined);
	if (!(await lakeraFlags({ text, instructions }))) return { auth: caller };
	return {
		auth: { ...caller, attributes: { ...caller.attributes, guardrail: GUARDRAIL_BLOCKED } },
		context: [REFUSAL_CONTEXT],
	};
}

export default eveChannel({
	// Browser tokens are what authorize; `verifyBrowserToken` also holds each one
	// to the origin the app issued it for.
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
		allowedHeaders: ["authorization", "content-type"],
		exposedHeaders: [
			"x-eve-session-id",
			"x-eve-stream-format",
			"x-eve-stream-tail-index",
			"x-eve-stream-version",
		],
		maxAge: 600,
	},
	auth: [
		async (request): Promise<SessionAuthContext | null> => {
			const token = extractBearerToken(request.headers.get("authorization"));

			if (credentialForm() === "self-hosted") {
				if (!matches(token, process.env.WANIWANI_API_KEY ?? "")) return null;
				const subject = request.headers.get("x-waniwani-visitor") || ANONYMOUS;
				return {
					attributes: withBackendHeaders(request, {}),
					authenticator: "waniwani-environment-key",
					issuer: "waniwani:agent",
					principalId: `waniwani:agent:${subject}`,
					principalType: "service",
					subject,
				};
			}

			const publicKey = appPublicKey();
			const browser = await verifyBrowserToken({ token, request, publicKey });
			if (browser) return withGrant(browser, token);

			const verified = await verifyJwtEcdsa(token, {
				algorithm: "ES256",
				audiences: ["waniwani-agent-runtime"],
				issuer: "waniwani:agent",
				publicKey,
			});
			if (!verified.ok) return null;
			const { sessionAuth } = verified;

			// eve authenticates a session-addressed route and authorizes nothing, so
			// the token has to name the session it is allowed to touch.
			const addressed = addressedSession(request);
			if (addressed !== undefined && sessionAuth.attributes.sid !== addressed) return null;

			return withGrant(
				{ ...sessionAuth, attributes: withBackendHeaders(request, sessionAuth.attributes) },
				token,
			);
		},
	],
	onMessage: (ctx, message) =>
		ctx.eve.caller ? guarded(ctx.eve.caller, messageText(message)) : { auth: null },
});
