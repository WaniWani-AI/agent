import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tenantOf } from "./tenant.js";

const ENV = "11111111-1111-4111-8111-111111111111";
const OTHER_ENV = "44444444-4444-4444-8444-444444444444";
const TUNNEL_A = "https://dev-a.waniwani.dev/mcp";
const TUNNEL_B = "https://dev-b.waniwani.dev/mcp";

function principal(attributes: Record<string, string>) {
	return {
		attributes,
		authenticator: "jwt-ecdsa",
		principalId: "waniwani:agent:visitor",
		principalType: "service",
		subject: "visitor",
	};
}

function initiatorOnly(attributes: Record<string, string>) {
	return { current: null, initiator: principal(attributes) };
}

function both(input: {
	initiator: Record<string, string>;
	current: Record<string, string>;
}) {
	return {
		initiator: principal(input.initiator),
		current: principal(input.current),
	};
}

let saved: { apiKey?: string; appKey?: string };

beforeEach(() => {
	saved = {
		apiKey: process.env.WANIWANI_API_KEY,
		appKey: process.env.WANIWANI_APP_PUBLIC_KEY,
	};
	delete process.env.WANIWANI_API_KEY;
	process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
});

afterEach(() => {
	if (saved.apiKey === undefined) delete process.env.WANIWANI_API_KEY;
	else process.env.WANIWANI_API_KEY = saved.apiKey;
	if (saved.appKey === undefined) delete process.env.WANIWANI_APP_PUBLIC_KEY;
	else process.env.WANIWANI_APP_PUBLIC_KEY = saved.appKey;
});

describe("a live token", () => {
	test("keeps the environment as its key and names no variant", () => {
		const tenant = tenantOf(initiatorOnly({ environmentId: ENV }));
		expect(tenant).toEqual({ key: ENV, environmentId: ENV });
		expect("variant" in tenant).toBe(false);
	});

	test("with a grant is still keyed by the environment alone", () => {
		const tenant = tenantOf(
			both({
				initiator: { environmentId: ENV, grant: "first.jwt" },
				current: { environmentId: ENV, grant: "second.jwt" },
			}),
		);
		expect(tenant).toEqual({
			key: ENV,
			environmentId: ENV,
			grant: "second.jwt",
		});
	});

	test("two visitors of one environment share one key", () => {
		const one = tenantOf(initiatorOnly({ environmentId: ENV, grant: "a.jwt" }));
		const two = tenantOf(initiatorOnly({ environmentId: ENV, grant: "b.jwt" }));
		expect(one.key).toBe(two.key);
	});

	test("empty variant claims count as absent", () => {
		const tenant = tenantOf(
			initiatorOnly({ environmentId: ENV, config: "", mcpUrl: "" }),
		);
		expect(tenant).toEqual({ key: ENV, environmentId: ENV });
	});

	test("a config claim other than draft is not a variant", () => {
		for (const config of [
			"live",
			"published",
			"Draft",
			"DRAFT",
			" draft",
			"draft ",
		]) {
			const tenant = tenantOf(initiatorOnly({ environmentId: ENV, config }));
			expect({ config, tenant }).toEqual({
				config,
				tenant: { key: ENV, environmentId: ENV },
			});
		}
	});
});

describe("a variant token", () => {
	test("a draft gets a key apart from the live one and names a variant", () => {
		const live = tenantOf(initiatorOnly({ environmentId: ENV }));
		const draft = tenantOf(
			initiatorOnly({ environmentId: ENV, config: "draft" }),
		);

		expect(draft.environmentId).toBe(ENV);
		expect(draft.key).not.toBe(live.key);
		expect(typeof draft.variant).toBe("string");
		expect(draft.variant).not.toBe("");
	});

	test("a tunnel gets a key apart from the live one and names a variant", () => {
		const live = tenantOf(initiatorOnly({ environmentId: ENV }));
		const tunnel = tenantOf(
			initiatorOnly({ environmentId: ENV, mcpUrl: TUNNEL_A }),
		);

		expect(tunnel.environmentId).toBe(ENV);
		expect(tunnel.key).not.toBe(live.key);
		expect(typeof tunnel.variant).toBe("string");
		expect(tunnel.variant).not.toBe("");
	});

	test("live, draft, each tunnel, and draft with each tunnel all get distinct keys", () => {
		const shapes: Array<Record<string, string>> = [
			{},
			{ config: "draft" },
			{ mcpUrl: TUNNEL_A },
			{ mcpUrl: TUNNEL_B },
			{ config: "draft", mcpUrl: TUNNEL_A },
			{ config: "draft", mcpUrl: TUNNEL_B },
			{ mcpUrl: `${TUNNEL_A}/` },
			{ mcpUrl: "https://dev-a.waniwani.dev/MCP" },
		];
		const keys = shapes.map(
			(shape) => tenantOf(initiatorOnly({ environmentId: ENV, ...shape })).key,
		);
		expect(new Set(keys).size).toBe(shapes.length);
	});

	test("the same variant of two environments gets two keys", () => {
		const one = tenantOf(
			initiatorOnly({ environmentId: ENV, config: "draft" }),
		);
		const two = tenantOf(
			initiatorOnly({ environmentId: OTHER_ENV, config: "draft" }),
		);
		expect(one.key).not.toBe(two.key);

		const tunnelOne = tenantOf(
			initiatorOnly({ environmentId: ENV, mcpUrl: TUNNEL_A }),
		);
		const tunnelTwo = tenantOf(
			initiatorOnly({ environmentId: OTHER_ENV, mcpUrl: TUNNEL_A }),
		);
		expect(tunnelOne.key).not.toBe(tunnelTwo.key);
	});

	test("no variant key equals any environment's live key, whatever the tunnel URL holds", () => {
		const tricky = [
			`${TUNNEL_A}|draft`,
			"draft",
			"|",
			"x|mcp=y",
			`mcp=${TUNNEL_A}`,
		];
		const variantKeys = [
			tenantOf(initiatorOnly({ environmentId: ENV, config: "draft" })).key,
			...tricky.map(
				(mcpUrl) => tenantOf(initiatorOnly({ environmentId: ENV, mcpUrl })).key,
			),
			...tricky.map(
				(mcpUrl) =>
					tenantOf(
						initiatorOnly({ environmentId: ENV, config: "draft", mcpUrl }),
					).key,
			),
		];
		expect(new Set(variantKeys).size).toBe(variantKeys.length);
		for (const key of variantKeys) {
			expect(key).not.toBe(ENV);
		}
	});

	test("no variant key equals any environment's live key", () => {
		const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
		const liveKeys = [ENV, OTHER_ENV].map(
			(environmentId) => tenantOf(initiatorOnly({ environmentId })).key,
		);
		expect(liveKeys).toEqual([ENV, OTHER_ENV]);

		const shapes: Array<Record<string, string>> = [
			{ config: "draft" },
			{ mcpUrl: TUNNEL_A },
			{ config: "draft", mcpUrl: TUNNEL_A },
			{ mcpUrl: OTHER_ENV },
			{ mcpUrl: ENV },
		];
		const variantKeys = [ENV, OTHER_ENV].flatMap((environmentId) =>
			shapes.map((shape) => tenantOf(initiatorOnly({ environmentId, ...shape })).key),
		);
		expect(new Set(variantKeys).size).toBe(variantKeys.length);
		for (const key of variantKeys) {
			expect(liveKeys).not.toContain(key);
			expect(uuid.test(key)).toBe(false);
		}
	});

	test("the same variant twice gets the same key", () => {
		const one = tenantOf(
			initiatorOnly({ environmentId: ENV, config: "draft", mcpUrl: TUNNEL_A }),
		);
		const two = tenantOf(
			initiatorOnly({
				environmentId: ENV,
				config: "draft",
				mcpUrl: TUNNEL_A,
				grant: "x.jwt",
			}),
		);
		expect(one.key).toBe(two.key);
		expect(one.variant).toBe(two.variant);
	});
});

describe("claim precedence: one token decides", () => {
	test("a draft claim on the current token makes a draft tenant", () => {
		const draft = tenantOf(initiatorOnly({ environmentId: ENV, config: "draft" }));
		const tenant = tenantOf(
			both({
				initiator: { environmentId: ENV },
				current: { environmentId: ENV, config: "draft" },
			}),
		);
		expect(tenant.key).toBe(draft.key);
		expect(tenant.variant).toBe(draft.variant);
	});

	test("a live current token is a live tenant even when the initiator was a draft", () => {
		const tenant = tenantOf(
			both({
				initiator: { environmentId: ENV, config: "draft", grant: "draft.jwt" },
				current: { environmentId: ENV, grant: "live.jwt" },
			}),
		);
		expect(tenant).toEqual({ key: ENV, environmentId: ENV, grant: "live.jwt" });
	});

	test("a live current token is a live tenant even when the initiator had a tunnel", () => {
		const tenant = tenantOf(
			both({
				initiator: { environmentId: ENV, mcpUrl: TUNNEL_A, grant: "tunnel.jwt" },
				current: { environmentId: ENV, grant: "live.jwt" },
			}),
		);
		expect(tenant).toEqual({ key: ENV, environmentId: ENV, grant: "live.jwt" });
	});

	test("the current token's tunnel wins over the initiator's", () => {
		const tunnelB = tenantOf(initiatorOnly({ environmentId: ENV, mcpUrl: TUNNEL_B }));
		const tenant = tenantOf(
			both({
				initiator: { environmentId: ENV, mcpUrl: TUNNEL_A },
				current: { environmentId: ENV, mcpUrl: TUNNEL_B },
			}),
		);
		expect(tenant.key).toBe(tunnelB.key);
	});

	test("a current draft and an initiator tunnel never combine", () => {
		const draftOnly = tenantOf(initiatorOnly({ environmentId: ENV, config: "draft" }));
		const tenant = tenantOf(
			both({
				initiator: { environmentId: ENV, mcpUrl: TUNNEL_A },
				current: { environmentId: ENV, config: "draft" },
			}),
		);
		expect(tenant.key).toBe(draftOnly.key);
	});

	test("a current tunnel and an initiator draft never combine", () => {
		const tunnelOnly = tenantOf(initiatorOnly({ environmentId: ENV, mcpUrl: TUNNEL_A }));
		const tenant = tenantOf(
			both({
				initiator: { environmentId: ENV, config: "draft" },
				current: { environmentId: ENV, mcpUrl: TUNNEL_A },
			}),
		);
		expect(tenant.key).toBe(tunnelOnly.key);
	});

	test("the grant comes from the same token as the claims, never from the initiator", () => {
		const tenant = tenantOf(
			both({
				initiator: { environmentId: ENV, grant: "initiator.jwt" },
				current: { environmentId: ENV, config: "draft" },
			}),
		);
		expect(tenant.grant).toBeUndefined();
		expect(tenant.variant).toBeDefined();
	});

	test("empty claims on the current token leave a live tenant with no grant", () => {
		const tenant = tenantOf(
			both({
				initiator: {
					environmentId: ENV,
					grant: "initiator.jwt",
					mcpUrl: TUNNEL_A,
					config: "draft",
				},
				current: { environmentId: ENV, grant: "", mcpUrl: "", config: "" },
			}),
		);
		expect(tenant).toEqual({ key: ENV, environmentId: ENV });
	});

	test("with no current token the initiator's claims and grant decide together", () => {
		const tenant = tenantOf(
			initiatorOnly({
				environmentId: ENV,
				grant: "initiator.jwt",
				config: "draft",
				mcpUrl: TUNNEL_A,
			}),
		);
		expect(tenant.grant).toBe("initiator.jwt");
		expect(tenant.key).not.toBe(ENV);
		expect(tenant.key).toBe(
			tenantOf(
				initiatorOnly({ environmentId: ENV, config: "draft", mcpUrl: TUNNEL_A }),
			).key,
		);
	});

	test("the environment still comes from the initiator, whatever the current token claims", () => {
		const tenant = tenantOf(
			both({
				initiator: { environmentId: ENV, config: "draft" },
				current: { environmentId: OTHER_ENV, config: "draft" },
			}),
		);
		expect(tenant.environmentId).toBe(ENV);
		expect(tenant.key).toBe(
			tenantOf(initiatorOnly({ environmentId: ENV, config: "draft" })).key,
		);
	});
});

describe("self-hosted", () => {
	beforeEach(() => {
		delete process.env.WANIWANI_APP_PUBLIC_KEY;
		process.env.WANIWANI_API_KEY = "wwk_unit";
	});

	test("variant claims never change the self tenant", () => {
		expect(
			tenantOf(initiatorOnly({ config: "draft", mcpUrl: TUNNEL_A })),
		).toEqual({
			key: "self",
		});
		expect(
			tenantOf(
				both({
					initiator: {},
					current: { config: "draft", mcpUrl: TUNNEL_A },
				}),
			),
		).toEqual({ key: "self" });
	});
});
