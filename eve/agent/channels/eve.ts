import { timingSafeEqual } from "node:crypto";
import type { SessionAuthContext } from "eve/context";
import { extractBearerToken, verifyJwtHmac } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import { ANONYMOUS, credentialForm } from "../lib/tenant.js";

function matches(token: string | null, expected: string): boolean {
	const actual = Buffer.from(token ?? "");
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function withExtra(
	request: Request,
	attributes: Readonly<Record<string, string | readonly string[]>>,
): Readonly<Record<string, string | readonly string[]>> {
	const extra = request.headers.get("x-waniwani-extra");
	return extra ? { ...attributes, extra } : attributes;
}

export default eveChannel({
	auth: [
		async (request): Promise<SessionAuthContext | null> => {
			const token = extractBearerToken(request.headers.get("authorization"));

			if (credentialForm() === "self-hosted") {
				if (!matches(token, process.env.WANIWANI_API_KEY ?? "")) {
					return null;
				}
				const subject =
					request.headers.get("x-waniwani-visitor") || ANONYMOUS;
				return {
					attributes: withExtra(request, {}),
					authenticator: "waniwani-environment-key",
					issuer: "waniwani:agent",
					principalId: `waniwani:agent:${subject}`,
					principalType: "service",
					subject,
				};
			}

			const result = await verifyJwtHmac(token, {
				algorithm: "HS256",
				audiences: ["waniwani-agent-runtime"],
				issuer: "waniwani:agent",
				secret: process.env.WANIWANI_AGENT_SECRET ?? "",
			});
			return result.ok
				? {
						...result.sessionAuth,
						attributes: withExtra(request, result.sessionAuth.attributes),
					}
				: null;
		},
	],
});
