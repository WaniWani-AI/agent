import { extractBearerToken, verifyJwtHmac } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

export default eveChannel({
	auth: [
		async (request) => {
			const secret = process.env.WANIWANI_AGENT_SECRET;
			if (!secret) {
				return null;
			}
			const result = await verifyJwtHmac(
				extractBearerToken(request.headers.get("authorization")),
				{
					algorithm: "HS256",
					audiences: ["waniwani-agent-runtime"],
					issuer: "waniwani:agent",
					secret,
				},
			);
			return result.ok ? result.sessionAuth : null;
		},
	],
});
