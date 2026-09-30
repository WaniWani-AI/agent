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
import {
	attachedDocumentsNote,
	attachedDocumentsOf,
	parseAttachedDocuments,
} from "../lib/attached-documents.js";
import { publishedNow } from "../lib/published.js";
import { reserveUserRow } from "../lib/reporting.js";
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

/**
 * What a browser sends with a message and the chat route takes from its body:
 * `extra` and documents only ever reach MCP `_meta`, so the guardrail does not
 * need to see them. A malformed value refuses the request, as the route does.
 */
function withBrowserHeaders(request: Request, auth: SessionAuthContext): SessionAuthContext | null {
	const documents = parseAttachedDocuments(request.headers.get("x-waniwani-documents"));
	const extra = request.headers.get("x-waniwani-extra");
	if (documents === null) return null;
	if (extra !== null) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(extra);
		} catch {
			return null;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	}
	return {
		...auth,
		attributes: {
			...auth.attributes,
			...(documents.length > 0 ? { documents: JSON.stringify(documents) } : {}),
			...(extra !== null ? { extra } : {}),
		},
	};
}

/** The app reads a hosted environment's config only for a caller holding a live token for it. */
function withGrant(auth: SessionAuthContext, token: string | null): SessionAuthContext {
	return token ? { ...auth, attributes: { ...auth.attributes, grant: token } } : auth;
}

async function screened(caller: SessionAuthContext, text: string): Promise<boolean> {
	const instructions = await publishedNow(tenantOf({ current: caller, initiator: caller }))
		.then((published) => published.config.instructions)
		.catch(() => undefined);
	return await lakeraFlags({ text, instructions });
}

/** Runs on the way to the model, so the reservation rides alongside the Lakera check. */
async function guarded(caller: SessionAuthContext, text: string) {
	if (caller.attributes.purpose !== "browser") return { auth: caller };
	const { environmentId, sid } = caller.attributes;
	const [flagged, userEventId] = await Promise.all([
		screened(caller, text),
		typeof environmentId === "string" && typeof sid === "string"
			? reserveUserRow({ environmentId, sessionId: sid })
			: undefined,
	]);
	const attributes = {
		...caller.attributes,
		...(userEventId !== undefined ? { userEventId: String(userEventId) } : {}),
	};
	if (flagged) {
		return {
			auth: { ...caller, attributes: { ...attributes, guardrail: GUARDRAIL_BLOCKED } },
			context: [REFUSAL_CONTEXT],
		};
	}
	const documents = attachedDocumentsOf(caller.attributes.documents);
	return {
		auth: { ...caller, attributes },
		...(documents.length > 0 ? { context: [attachedDocumentsNote(documents)] } : {}),
	};
}

export default eveChannel({
	// Browser tokens are what authorize; `verifyBrowserToken` also holds each one
	// to the origin the app issued it for.
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
		allowedHeaders: ["authorization", "content-type", "x-waniwani-documents", "x-waniwani-extra"],
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
			if (browser) {
				const withTurnInput = withBrowserHeaders(request, browser);
				return withTurnInput ? withGrant(withTurnInput, token) : null;
			}

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
