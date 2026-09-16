import { timingSafeEqual } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import { extractBearerToken, verifyJwtHmac } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { ANONYMOUS, credentialForm } from "../lib/tenant.js";

type Attributes = Readonly<Record<string, string | readonly string[]>>;

function matches(token: string | null, expected: string): boolean {
	const actual = Buffer.from(token ?? "");
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function withExtra(request: Request, attributes: Attributes): Attributes {
	const extra = request.headers.get("x-waniwani-extra");
	return extra ? { ...attributes, extra } : attributes;
}

export default eveChannel({
	auth: [
		async (request): Promise<SessionAuthContext | null> => {
			const token = extractBearerToken(request.headers.get("authorization"));

			if (credentialForm() === "self-hosted") {
				if (!matches(token, process.env.WANIWANI_API_KEY ?? "")) return null;
				const subject = request.headers.get("x-waniwani-visitor") || ANONYMOUS;
				return {
					attributes: withExtra(request, {}),
					authenticator: "waniwani-environment-key",
					issuer: "waniwani:agent",
					principalId: `waniwani:agent:${subject}`,
					principalType: "service",
					subject,
				};
			}

			const verified = await verifyJwtHmac(token, {
				algorithm: "HS256",
				audiences: ["waniwani-agent-runtime"],
				issuer: "waniwani:agent",
				secret: process.env.WANIWANI_AGENT_SECRET ?? "",
			});
			if (!verified.ok) return null;
			const { sessionAuth } = verified;
			return { ...sessionAuth, attributes: withExtra(request, sessionAuth.attributes) };
		},
	],
});
