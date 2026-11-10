import { generateKeyPairSync } from "node:crypto";
import type { Tenant } from "./tenant.js";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	setSystemTime,
	test,
} from "bun:test";

const WINDOW_MS = 60_000;
const MINUTE_MS = 60_000;
const START = Date.parse("2026-09-14T09:00:00.000Z");

const API_URL = "https://app.test.invalid";
const CONFIG_PATH = "/api/mcp/agent/config";
const MCP_URL = "http://mcp.test.invalid:3002";

// Generated per run: the hosted path has to mint a real service token, and a
// PEM committed to a public repo is a secret-scanner alert for no reason.
const SERVICE_KEY = generateKeyPairSync("ed25519")
	.privateKey.export({ type: "pkcs8", format: "pem" })
	.toString();

type Recorded = {
	url: string;
	ifNoneMatch: string | null;
	authorization: string | null;
	grant: string | null;
	configSource: string | null;
};
type Replier = (request: Recorded) => Response;

let calls: Recorded[] = [];
let reply: Replier;
let listTools: () => Promise<Array<{ name: string; inputSchema: object }>>;

mock.module("./mcp-catalog.js", () => ({
	listMcpTools: () => listTools(),
	callMcpTool: () => {
		throw new Error("not used here");
	},
	textOf: () => "",
}));

const { publishedNow, revalidatePublished, resetPublished, cacheState } =
	await import("./published.js");
const {
	tenantOf,
	assertCallerOwnsSession,
	credentialForm,
	resolveChannel,
	configRequest,
} = await import("./tenant.js");

const ALPHA = { key: "alpha", environmentId: "alpha" };
const BRAVO = { key: "bravo", environmentId: "bravo" };
const SELF = { key: "self" };

function ok(instructions: string, etag: string): Response {
	return new Response(
		JSON.stringify({
			success: true,
			message: "success",
			data: {
				environmentId: "11111111-1111-4111-8111-111111111111",
				configId: "22222222-2222-4222-8222-222222222222",
				instructions,
				model: { mode: "managed", modelId: "openai/test" },
				mcpUrl: MCP_URL,
				webSearch: null,
				channels: [{ id: "c1", label: "website", title: "Website" }],
			},
		}),
		{ status: 200, headers: { "content-type": "application/json", etag } },
	);
}

function gone(message: string): Response {
	return new Response(JSON.stringify({ success: false, message }), {
		status: 404,
		headers: { "content-type": "application/json" },
	});
}

function configCalls(): Recorded[] {
	return calls.filter((call) => call.url.includes(CONFIG_PATH));
}

async function settle(): Promise<void> {
	for (let tick = 0; tick < 8; tick += 1) {
		await Promise.resolve();
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("published", () => {
	let originalFetch: typeof fetch;

	beforeEach(() => {
		setSystemTime(new Date(START));
		resetPublished();
		calls = [];
		reply = () => ok("first", '"e1"');
		listTools = async () => [
			{ name: "echo", inputSchema: { type: "object" as const } },
		];
		originalFetch = globalThis.fetch;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : String(input);
			const headers = new Headers(init?.headers);
			const recorded: Recorded = {
				url,
				ifNoneMatch: headers.get("if-none-match"),
				authorization: headers.get("authorization"),
				grant: headers.get("x-waniwani-grant"),
				configSource: headers.get("x-waniwani-config-source"),
			};
			calls.push(recorded);
			if (!url.includes(CONFIG_PATH)) {
				throw new Error(`unexpected fetch: ${url}`);
			}
			return reply(recorded);
		}) as typeof fetch;

		process.env.WANIWANI_API_URL = API_URL;
		process.env.WANIWANI_API_KEY = "wwk_unit";
		process.env.WANIWANI_SERVICE_PRIVATE_KEY = SERVICE_KEY;
		process.env.WANIWANI_REGION = "eu";
		delete process.env.WANIWANI_APP_PUBLIC_KEY;
		delete process.env.WANIWANI_CHANNEL_ID;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		setSystemTime();
		delete process.env.WANIWANI_SERVICE_PRIVATE_KEY;
		delete process.env.WANIWANI_APP_PUBLIC_KEY;
	});

	test("a cold tenant waits for its first pass", async () => {
		const published = await publishedNow(ALPHA);

		expect(published.config.instructions).toBe("first");
		expect(published.tools.map((tool) => tool.name)).toEqual(["echo"]);
		expect(configCalls()).toHaveLength(1);
	});

	test("a warm tenant answers from memory without waiting", async () => {
		await publishedNow(ALPHA);
		reply = () => ok("second", '"e2"');

		expect((await publishedNow(ALPHA)).config.instructions).toBe("first");
	});

	test("two tenants keep separate copies and separate tags", async () => {
		reply = (request) =>
			request.url.includes("alpha") ? ok("alpha", '"a"') : ok("bravo", '"b"');

		expect((await publishedNow(ALPHA)).config.instructions).toBe("alpha");
		expect((await publishedNow(BRAVO)).config.instructions).toBe("bravo");

		setSystemTime(new Date(START + WINDOW_MS + 1));
		await publishedNow(ALPHA);
		await settle();

		expect(configCalls().map((call) => call.ifNoneMatch)).toEqual([
			null,
			null,
			'"a"',
		]);
	});

	test("one tenant's outage never disturbs another's copy", async () => {
		reply = (request) =>
			request.url.includes("alpha")
				? ok("alpha", '"a"')
				: new Response("boom", { status: 500 });

		await publishedNow(ALPHA);
		await expect(publishedNow(BRAVO)).rejects.toThrow(/500/);
		expect((await publishedNow(ALPHA)).config.instructions).toBe("alpha");
	});

	test("a failed revalidation keeps the copy already in memory", async () => {
		await publishedNow(ALPHA);

		reply = () => new Response("boom", { status: 500 });
		setSystemTime(new Date(START + WINDOW_MS + 1));

		expect((await publishedNow(ALPHA)).config.instructions).toBe("first");
		await settle();
		expect((await publishedNow(ALPHA)).config.instructions).toBe("first");
		expect(configCalls()).toHaveLength(2);
	});

	test("a publish lands on the turn after the revalidation", async () => {
		await publishedNow(ALPHA);

		reply = () => ok("second", '"e2"');
		setSystemTime(new Date(START + WINDOW_MS + 1));

		expect((await publishedNow(ALPHA)).config.instructions).toBe("first");
		await settle();
		expect((await publishedNow(ALPHA)).config.instructions).toBe("second");
	});

	test("a 304 keeps the copy and keeps sending its tag", async () => {
		await publishedNow(ALPHA);

		reply = () => new Response(null, { status: 304, headers: { etag: '"e1"' } });
		setSystemTime(new Date(START + WINDOW_MS + 1));
		await publishedNow(ALPHA);
		await settle();

		setSystemTime(new Date(START + 2 * WINDOW_MS + 2));
		await publishedNow(ALPHA);
		await settle();

		expect(configCalls().at(-1)?.ifNoneMatch).toBe('"e1"');
		expect((await publishedNow(ALPHA)).config.instructions).toBe("first");
	});

	test("a tool listing failure fails the pass, leaving no half copy", async () => {
		listTools = async () => {
			throw new Error("mcp down");
		};

		await expect(publishedNow(ALPHA)).rejects.toThrow(/mcp down/);
		setSystemTime(new Date(START + WINDOW_MS + 1));
		listTools = async () => [
			{ name: "echo", inputSchema: { type: "object" as const } },
		];
		expect((await publishedNow(ALPHA)).tools).toHaveLength(1);
	});

	test("a cold failure is not retried inside the window", async () => {
		reply = () => new Response("boom", { status: 500 });

		await expect(publishedNow(ALPHA)).rejects.toThrow(/500/);
		await expect(publishedNow(ALPHA)).rejects.toThrow(
			/No published configuration/,
		);
		expect(configCalls()).toHaveLength(1);
	});

	test("a cold failure is retried once the window passes", async () => {
		reply = () => new Response("boom", { status: 500 });
		await expect(publishedNow(ALPHA)).rejects.toThrow(/500/);

		setSystemTime(new Date(START + WINDOW_MS + 1));
		reply = () => ok("recovered", '"e9"');
		expect((await publishedNow(ALPHA)).config.instructions).toBe("recovered");
	});

	test("concurrent cold reads share one pass", async () => {
		const [one, two] = await Promise.all([
			publishedNow(ALPHA),
			publishedNow(ALPHA),
		]);

		expect(one.config.instructions).toBe("first");
		expect(two.config.instructions).toBe("first");
		expect(configCalls()).toHaveLength(1);
	});

	test("a revalidation inside the window is skipped", async () => {
		await publishedNow(ALPHA);

		revalidatePublished(ALPHA);
		revalidatePublished(ALPHA);
		await settle();
		expect(configCalls()).toHaveLength(1);
	});

	test("an environment tenant names itself and signs a service token", async () => {
		await publishedNow(ALPHA);

		const call = configCalls()[0];
		expect(call?.url).toContain("environmentId=alpha");
		expect(call?.authorization?.startsWith("Bearer eyJ")).toBe(true);
		expect(call?.authorization).not.toContain("wwk_");
	});

	test("the self tenant sends its environment key and names no environment", async () => {
		await publishedNow(SELF);

		const call = configCalls()[0];
		expect(call?.url).not.toContain("environmentId=");
		expect(call?.authorization).toBe("Bearer wwk_unit");
	});

	test("an environment tenant's grant rides along on the config read", async () => {
		await publishedNow({ ...ALPHA, grant: "app.signed.token" });

		expect(configCalls()[0]?.grant).toBe("app.signed.token");
	});

	test("the self tenant sends no grant", async () => {
		await publishedNow(SELF);

		expect(configCalls()[0]?.grant).toBeNull();
	});

	test("a 404 on revalidation drops the warm copy at once", async () => {
		await publishedNow(ALPHA);

		reply = () => gone("NO_LIVE_CONFIG");
		setSystemTime(new Date(START + WINDOW_MS + 1));
		await publishedNow(ALPHA);
		await settle();

		await expect(publishedNow(ALPHA)).rejects.toThrow(/NO_LIVE_CONFIG/);
		expect(configCalls()).toHaveLength(2);

		reply = () => ok("republished", '"e2"');
		setSystemTime(new Date(START + 2 * WINDOW_MS + 2));
		expect((await publishedNow(ALPHA)).config.instructions).toBe("republished");
		expect(configCalls().at(-1)?.ifNoneMatch).toBeNull();
	});

	test("a 404 on a blocking pass past the staleness cap fails the turn", async () => {
		await publishedNow(ALPHA);

		reply = () => gone("ENVIRONMENT_NOT_FOUND");
		setSystemTime(new Date(START + 10 * MINUTE_MS + 1));

		await expect(publishedNow(ALPHA)).rejects.toThrow(/ENVIRONMENT_NOT_FOUND/);
		await expect(publishedNow(ALPHA)).rejects.toThrow(/No published configuration/);
	});

	test("transient failures keep serving the copy for ten minutes", async () => {
		await publishedNow(ALPHA);

		const failures = [
			() => new Response("boom", { status: 500 }),
			() => new Response("slow down", { status: 429 }),
			() => new Response("nope", { status: 401 }),
		];
		for (const [index, failure] of failures.entries()) {
			reply = failure;
			setSystemTime(new Date(START + (index + 1) * 3 * MINUTE_MS));
			expect((await publishedNow(ALPHA)).config.instructions).toBe("first");
			await settle();
		}

		listTools = async () => {
			throw new Error("mcp down");
		};
		reply = () => ok("second", '"e2"');
		setSystemTime(new Date(START + 10 * MINUTE_MS));
		expect((await publishedNow(ALPHA)).config.instructions).toBe("first");
		await settle();
		expect(configCalls()).toHaveLength(5);
	});

	test("past ten minutes without a successful check the turn fails", async () => {
		await publishedNow(ALPHA);

		reply = () => new Response("boom", { status: 503 });
		setSystemTime(new Date(START + 5 * MINUTE_MS));
		await publishedNow(ALPHA);
		await settle();

		setSystemTime(new Date(START + 10 * MINUTE_MS + 1));
		await expect(publishedNow(ALPHA)).rejects.toThrow(/503/);
		await expect(publishedNow(ALPHA)).rejects.toThrow(/No published configuration/);
		expect(configCalls()).toHaveLength(3);

		reply = () => new Response(null, { status: 304 });
		setSystemTime(new Date(START + 11 * MINUTE_MS + 2));
		expect((await publishedNow(ALPHA)).config.instructions).toBe("first");
	});

	test("a 304 counts as a successful check for the staleness cap", async () => {
		await publishedNow(ALPHA);

		reply = () => new Response(null, { status: 304 });
		setSystemTime(new Date(START + 9 * MINUTE_MS));
		await publishedNow(ALPHA);
		await settle();

		reply = () => new Response("boom", { status: 500 });
		setSystemTime(new Date(START + 15 * MINUTE_MS));
		expect((await publishedNow(ALPHA)).config.instructions).toBe("first");
		await settle();

		setSystemTime(new Date(START + 19 * MINUTE_MS + 1));
		await expect(publishedNow(ALPHA)).rejects.toThrow(/500/);
	});

	test("an incomplete payload fails rather than serving a blank prompt", async () => {
		reply = () =>
			new Response(
				JSON.stringify({ success: true, message: "success", data: {} }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		await expect(publishedNow(ALPHA)).rejects.toThrow(/incomplete/);
	});

	describe("a draft tenant", () => {
		const DRAFT: Tenant = { key: "alpha", environmentId: "alpha", draft: true };

		function byConfigSource(input: { live: string; draft: string }): Replier {
			return (request) =>
				request.configSource === "draft"
					? ok(input.draft, '"d"')
					: ok(input.live, '"l"');
		}

		test("a draft read names the draft source next to its grant and service token", async () => {
			await publishedNow({ ...DRAFT, grant: "app.signed.token" });

			const call = configCalls()[0];
			expect(call?.url).toContain("environmentId=alpha");
			expect(call?.authorization?.startsWith("Bearer eyJ")).toBe(true);
			expect(call?.grant).toBe("app.signed.token");
			expect(call?.configSource).toBe("draft");
			expect(call?.ifNoneMatch).toBeNull();
		});

		test("a live read names no config source", async () => {
			await publishedNow({ ...ALPHA, grant: "app.signed.token" });

			expect(configCalls()[0]?.configSource).toBeNull();
		});

		test("a cold draft read returns the fetched config and its listed tools", async () => {
			reply = () => ok("draft prompt", '"d1"');
			listTools = async () => [
				{ name: "draft-tool", inputSchema: { type: "object" as const } },
			];

			const published = await publishedNow(DRAFT);

			expect(published.config.instructions).toBe("draft prompt");
			expect(published.tools.map((tool) => tool.name)).toEqual(["draft-tool"]);
		});

		test("every draft read fetches again inside the window, with no tag", async () => {
			reply = () => ok("draft one", '"d1"');
			listTools = async () => [
				{ name: "tool-one", inputSchema: { type: "object" as const } },
			];
			const first = await publishedNow(DRAFT);

			reply = () => ok("draft two", '"d2"');
			listTools = async () => [
				{ name: "tool-two", inputSchema: { type: "object" as const } },
			];
			const second = await publishedNow(DRAFT);

			reply = () => ok("draft three", '"d3"');
			const third = await publishedNow(DRAFT);

			expect(first.config.instructions).toBe("draft one");
			expect(second.config.instructions).toBe("draft two");
			expect(second.tools.map((tool) => tool.name)).toEqual(["tool-two"]);
			expect(third.config.instructions).toBe("draft three");
			expect(configCalls().map((call) => call.ifNoneMatch)).toEqual([
				null,
				null,
				null,
			]);
			expect(configCalls().map((call) => call.configSource)).toEqual([
				"draft",
				"draft",
				"draft",
			]);
		});

		test("a 304 answer to a draft read is never resolved from a cached copy", async () => {
			await publishedNow(ALPHA);
			reply = () => new Response(null, { status: 304, headers: { etag: '"e1"' } });

			await expect(publishedNow(DRAFT)).rejects.toThrow();
		});

		test("a warm live copy is never served to a draft reader", async () => {
			reply = byConfigSource({ live: "live prompt", draft: "draft prompt" });
			await publishedNow(ALPHA);

			const draft = await publishedNow(DRAFT);

			expect(draft.config.instructions).toBe("draft prompt");
			const draftCall = configCalls().at(-1);
			expect(draftCall?.configSource).toBe("draft");
			expect(draftCall?.ifNoneMatch).toBeNull();
		});

		test("a draft read leaves the warm live copy as it was", async () => {
			reply = byConfigSource({ live: "live prompt", draft: "draft prompt" });
			await publishedNow(ALPHA);
			await publishedNow(DRAFT);

			expect((await publishedNow(ALPHA)).config.instructions).toBe("live prompt");
			expect(cacheState(ALPHA)).toBe("warm");
			expect(configCalls()).toHaveLength(2);
		});

		test("a draft read never warms the live cache", async () => {
			reply = byConfigSource({ live: "live prompt", draft: "draft prompt" });
			await publishedNow(DRAFT);

			expect(cacheState(ALPHA)).toBe("cold");
			expect((await publishedNow(ALPHA)).config.instructions).toBe("live prompt");
			const liveCall = configCalls().at(-1);
			expect(configCalls()).toHaveLength(2);
			expect(liveCall?.configSource).toBeNull();
			expect(liveCall?.ifNoneMatch).toBeNull();
		});

		test("the live revalidation after a draft read never sends the draft's tag", async () => {
			reply = byConfigSource({ live: "live prompt", draft: "draft prompt" });
			await publishedNow(ALPHA);
			await publishedNow(DRAFT);

			setSystemTime(new Date(START + WINDOW_MS + 1));
			await publishedNow(ALPHA);
			await settle();

			const liveCalls = configCalls().filter((call) => call.configSource === null);
			expect(liveCalls.map((call) => call.ifNoneMatch)).toEqual([null, '"l"']);
		});

		test("live and draft reads started together each get their own answer", async () => {
			reply = byConfigSource({ live: "live prompt", draft: "draft prompt" });

			const [live, draft] = await Promise.all([
				publishedNow(ALPHA),
				publishedNow(DRAFT),
			]);

			expect(live.config.instructions).toBe("live prompt");
			expect(draft.config.instructions).toBe("draft prompt");
			expect(configCalls()).toHaveLength(2);
		});

		test("a draft read started first never becomes the live readers' pass", async () => {
			reply = byConfigSource({ live: "live prompt", draft: "draft prompt" });

			const [draft, live] = await Promise.all([
				publishedNow(DRAFT),
				publishedNow(ALPHA),
			]);

			expect(draft.config.instructions).toBe("draft prompt");
			expect(live.config.instructions).toBe("live prompt");
		});

		test("a draft read past the window triggers no live revalidation", async () => {
			reply = byConfigSource({ live: "live prompt", draft: "draft prompt" });
			await publishedNow(ALPHA);

			setSystemTime(new Date(START + WINDOW_MS + 1));
			await publishedNow(DRAFT);
			await settle();

			expect(configCalls().map((call) => call.configSource)).toEqual([
				null,
				"draft",
			]);
			expect(cacheState(ALPHA)).toBe("stale");
		});

		test("cacheState reports cold for a draft tenant, whatever the live copy holds", async () => {
			expect(cacheState(DRAFT)).toBe("cold");

			await publishedNow(ALPHA);
			expect(cacheState(DRAFT)).toBe("cold");

			await publishedNow(DRAFT);
			expect(cacheState(DRAFT)).toBe("cold");
		});

		test("revalidating a draft tenant fetches nothing when the live copy is cold", async () => {
			revalidatePublished(DRAFT);
			await settle();

			expect(configCalls()).toHaveLength(0);
			expect(cacheState(ALPHA)).toBe("cold");
		});

		test("revalidating a draft tenant leaves a stale live copy stale", async () => {
			await publishedNow(ALPHA);
			setSystemTime(new Date(START + WINDOW_MS + 1));

			revalidatePublished(DRAFT);
			await settle();

			expect(configCalls()).toHaveLength(1);
			expect(cacheState(ALPHA)).toBe("stale");
		});

		test("a failed draft read keeps the warm live copy", async () => {
			reply = (request) =>
				request.configSource === "draft"
					? new Response("boom", { status: 500 })
					: ok("live prompt", '"l"');
			await publishedNow(ALPHA);

			await expect(publishedNow(DRAFT)).rejects.toThrow(/500/);

			expect((await publishedNow(ALPHA)).config.instructions).toBe("live prompt");
			expect(cacheState(ALPHA)).toBe("warm");
		});

		test("a draft 404 never drops the warm live copy", async () => {
			reply = (request) =>
				request.configSource === "draft"
					? gone("NO_DRAFT_CONFIG")
					: ok("live prompt", '"l"');
			await publishedNow(ALPHA);

			await expect(publishedNow(DRAFT)).rejects.toThrow(/NO_DRAFT_CONFIG/);

			expect((await publishedNow(ALPHA)).config.instructions).toBe("live prompt");
		});

		test("a failed draft read leaves no failure for a cold live reader inside the window", async () => {
			reply = (request) =>
				request.configSource === "draft"
					? new Response("boom", { status: 500 })
					: ok("live prompt", '"l"');

			await expect(publishedNow(DRAFT)).rejects.toThrow(/500/);

			expect((await publishedNow(ALPHA)).config.instructions).toBe("live prompt");
		});

		test("a failed draft tool listing keeps the warm live copy", async () => {
			reply = byConfigSource({ live: "live prompt", draft: "draft prompt" });
			await publishedNow(ALPHA);
			listTools = async () => {
				throw new Error("mcp down");
			};

			await expect(publishedNow(DRAFT)).rejects.toThrow(/mcp down/);

			expect((await publishedNow(ALPHA)).config.instructions).toBe("live prompt");
			expect(cacheState(ALPHA)).toBe("warm");
		});

		test("a failed draft read is retried on the very next draft read", async () => {
			reply = () => new Response("boom", { status: 500 });
			await expect(publishedNow(DRAFT)).rejects.toThrow(/500/);

			reply = () => ok("draft recovered", '"d2"');
			expect((await publishedNow(DRAFT)).config.instructions).toBe("draft recovered");
		});

		test("a failed live read never blocks a draft read inside the window", async () => {
			reply = (request) =>
				request.configSource === "draft"
					? ok("draft prompt", '"d"')
					: new Response("boom", { status: 500 });
			await expect(publishedNow(ALPHA)).rejects.toThrow(/500/);

			expect((await publishedNow(DRAFT)).config.instructions).toBe("draft prompt");
		});

		test("a session started as a draft reads the draft end to end", async () => {
			delete process.env.WANIWANI_API_KEY;
			process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
			reply = byConfigSource({ live: "live prompt", draft: "draft prompt" });
			const initiator = {
				attributes: { environmentId: "alpha", configSource: "draft" },
				authenticator: "jwt-ecdsa",
				principalId: "waniwani:agent:visitor",
				principalType: "service",
				subject: "visitor",
			};

			const tenant = tenantOf({ current: initiator, initiator });

			expect((await publishedNow(tenant)).config.instructions).toBe("draft prompt");
			expect(cacheState(tenant)).toBe("cold");
			expect(cacheState(ALPHA)).toBe("cold");
		});
	});
});

describe("credentialForm and tenantOf", () => {
	function auth(attributes: Record<string, string>) {
		return {
			current: null,
			initiator: {
				attributes,
				authenticator: "jwt-ecdsa",
				principalId: "waniwani:agent:visitor",
				principalType: "service",
				subject: "visitor",
			},
		};
	}

	beforeEach(() => {
		delete process.env.WANIWANI_API_KEY;
		delete process.env.WANIWANI_APP_PUBLIC_KEY;
		delete process.env.WANIWANI_CHANNEL_ID;
	});

	test("the environment key alone selects the self-hosted form", () => {
		process.env.WANIWANI_API_KEY = "wwk_unit";
		expect(credentialForm()).toBe("self-hosted");
	});

	test("the app public key alone selects the hosted form", () => {
		process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
		expect(credentialForm()).toBe("hosted");
	});

	test("both forms configured is refused", () => {
		process.env.WANIWANI_API_KEY = "wwk_unit";
		process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
		expect(() => credentialForm()).toThrow(/exactly one/);
	});

	test("neither form configured is refused", () => {
		expect(() => credentialForm()).toThrow(/exactly one/);
	});

	test("a claimed environment is the tenant key on the hosted form", () => {
		process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
		expect(tenantOf(auth({ environmentId: "env-1" }))).toEqual({
			key: "env-1",
			environmentId: "env-1",
		});
	});

	test("the hosted form takes the current caller's grant over the initiator's", () => {
		process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
		const { initiator } = auth({ environmentId: "env-1", grant: "initiator.token" });
		const current = {
			...initiator,
			attributes: { environmentId: "env-1", grant: "current.token" },
		};
		expect(tenantOf({ current, initiator }).grant).toBe("current.token");
		expect(tenantOf({ current: null, initiator }).grant).toBe("initiator.token");
	});

	test("a grant never reaches the self tenant", () => {
		process.env.WANIWANI_API_KEY = "wwk_unit";
		expect(tenantOf(auth({ grant: "stray.token" }))).toEqual({ key: "self" });
	});

	test("the self-hosted form is always the self tenant", () => {
		process.env.WANIWANI_API_KEY = "wwk_unit";
		expect(tenantOf(auth({}))).toEqual({ key: "self" });
	});

	test("a claimed environment on the self-hosted form fails the turn", () => {
		process.env.WANIWANI_API_KEY = "wwk_unit";
		expect(() => tenantOf(auth({ environmentId: "env-1" }))).toThrow(
			/WANIWANI_API_KEY/,
		);
	});

	test("no claimed environment on the hosted form fails the turn", () => {
		process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
		expect(() => tenantOf(auth({}))).toThrow(/WANIWANI_APP_PUBLIC_KEY/);
	});
});

describe("the draft config source on the tenant", () => {
	type Attributes = Record<string, string | readonly string[]>;

	function credential(attributes: Attributes) {
		return {
			attributes,
			authenticator: "jwt-ecdsa",
			principalId: "waniwani:agent:visitor",
			principalType: "service",
			subject: "visitor",
		};
	}

	function headersFor(input: { initiator: Attributes; current?: Attributes }) {
		const initiator = credential(input.initiator);
		const current = input.current ? credential(input.current) : null;
		return configRequest(tenantOf({ current, initiator })).headers;
	}

	beforeEach(() => {
		delete process.env.WANIWANI_API_KEY;
		delete process.env.WANIWANI_CHANNEL_ID;
		process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
		process.env.WANIWANI_SERVICE_PRIVATE_KEY = SERVICE_KEY;
		process.env.WANIWANI_REGION = "eu";
		process.env.WANIWANI_API_URL = API_URL;
	});

	afterEach(() => {
		delete process.env.WANIWANI_APP_PUBLIC_KEY;
		delete process.env.WANIWANI_SERVICE_PRIVATE_KEY;
		delete process.env.WANIWANI_API_KEY;
	});

	test("an initiator claiming the draft source makes a draft tenant", () => {
		const tenant = tenantOf({
			current: null,
			initiator: credential({ environmentId: "env-1", configSource: "draft" }),
		});

		expect(tenant.draft).toBe(true);
		expect(tenant.environmentId).toBe("env-1");
		expect(configRequest(tenant).headers["x-waniwani-config-source"]).toBe("draft");
	});

	test("a draft config request carries authorization, grant and source together", () => {
		const headers = headersFor({
			initiator: {
				environmentId: "env-1",
				configSource: "draft",
				grant: "app.signed.token",
			},
		});

		expect(Object.keys(headers).sort()).toEqual([
			"authorization",
			"x-waniwani-config-source",
			"x-waniwani-grant",
		]);
		expect(headers.authorization?.startsWith("Bearer eyJ")).toBe(true);
		expect(headers["x-waniwani-grant"]).toBe("app.signed.token");
		expect(headers["x-waniwani-config-source"]).toBe("draft");
	});

	test("a draft config request still names its environment on the config route", () => {
		const { url } = configRequest(
			tenantOf({
				current: null,
				initiator: credential({ environmentId: "env-1", configSource: "draft" }),
			}),
		);

		expect(url).toBe(`${API_URL}${CONFIG_PATH}?environmentId=env-1`);
	});

	test("a live config request carries only authorization and grant", () => {
		const headers = headersFor({
			initiator: { environmentId: "env-1", grant: "app.signed.token" },
		});

		expect(Object.keys(headers).sort()).toEqual(["authorization", "x-waniwani-grant"]);
	});

	test("a later token claiming draft never turns a live session into a draft", () => {
		const tenant = tenantOf({
			current: credential({ environmentId: "env-1", configSource: "draft" }),
			initiator: credential({ environmentId: "env-1" }),
		});

		expect(tenant.draft).toBeUndefined();
		expect(configRequest(tenant).headers["x-waniwani-config-source"]).toBeUndefined();
	});

	test("a later token claiming live keeps a draft session a draft", () => {
		const headers = headersFor({
			initiator: { environmentId: "env-1", configSource: "draft" },
			current: { environmentId: "env-1", configSource: "live" },
		});

		expect(headers["x-waniwani-config-source"]).toBe("draft");
	});

	test("a later token naming no source keeps a draft session a draft", () => {
		const headers = headersFor({
			initiator: { environmentId: "env-1", configSource: "draft" },
			current: { environmentId: "env-1", grant: "browser.token" },
		});

		expect(headers["x-waniwani-config-source"]).toBe("draft");
		expect(headers["x-waniwani-grant"]).toBe("browser.token");
	});

	const liveValues: Array<[string, string | readonly string[]]> = [
		["live", "live"],
		["empty", ""],
		["capitalized", "Draft"],
		["padded", " draft"],
		["shouted", "DRAFT"],
		["a list holding draft", ["draft"]],
	];
	for (const [label, value] of liveValues) {
		test(`a ${label} config source is a live tenant`, () => {
			const tenant = tenantOf({
				current: null,
				initiator: credential({ environmentId: "env-1", configSource: value }),
			});

			expect(tenant.draft).toBeUndefined();
			expect(configRequest(tenant).headers["x-waniwani-config-source"]).toBeUndefined();
		});
	}

	test("the self-hosted form ignores a draft claim", () => {
		delete process.env.WANIWANI_APP_PUBLIC_KEY;
		process.env.WANIWANI_API_KEY = "wwk_unit";

		const tenant = tenantOf({
			current: null,
			initiator: credential({ configSource: "draft" }),
		});

		expect(tenant).toEqual({ key: "self" });
		expect(configRequest(tenant)).toEqual({
			url: `${API_URL}${CONFIG_PATH}`,
			headers: { authorization: "Bearer wwk_unit" },
		});
	});
});

describe("resolveChannel", () => {
	const channels = [
		{ id: "chan-1", label: "website" },
		{ id: "chan-2", label: "widget" },
	];

	function auth(attributes: Record<string, string>) {
		return {
			current: null,
			initiator: {
				attributes,
				authenticator: "jwt-ecdsa",
				principalId: "waniwani:agent:visitor",
				principalType: "service",
				subject: "visitor",
			},
		};
	}

	beforeEach(() => {
		delete process.env.WANIWANI_API_KEY;
		delete process.env.WANIWANI_APP_PUBLIC_KEY;
		delete process.env.WANIWANI_CHANNEL_ID;
	});

	test("the hosted form takes the channel off the claim", () => {
		process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
		expect(
			resolveChannel({ auth: auth({ channelId: "chan-2" }), channels }),
		).toEqual({ id: "chan-2", label: "widget" });
	});

	test("a hosted claim falls back to the first channel when absent", () => {
		process.env.WANIWANI_APP_PUBLIC_KEY = "app-public-key";
		expect(resolveChannel({ auth: auth({}), channels })).toEqual(channels[0]);
	});

	test("the self-hosted form takes the configured channel", () => {
		process.env.WANIWANI_API_KEY = "wwk_unit";
		process.env.WANIWANI_CHANNEL_ID = "chan-2";
		expect(resolveChannel({ auth: auth({}), channels })).toEqual(channels[1]);
	});

	test("an unconfigured self-hosted deployment takes the first channel", () => {
		process.env.WANIWANI_API_KEY = "wwk_unit";
		expect(resolveChannel({ auth: auth({}), channels })).toEqual(channels[0]);
	});

	test("a configured channel the environment never published fails the turn", () => {
		process.env.WANIWANI_API_KEY = "wwk_unit";
		process.env.WANIWANI_CHANNEL_ID = "chan-9";
		expect(() => resolveChannel({ auth: auth({}), channels })).toThrow(
			/chan-9/,
		);
	});
});

describe("assertCallerOwnsSession", () => {
	function principal(input: { subject: string; environmentId?: string }) {
		const attributes: Record<string, string> = {};
		if (input.environmentId) attributes.environmentId = input.environmentId;
		return {
			attributes,
			authenticator: "jwt-ecdsa",
			principalId: `waniwani:agent:${input.subject}`,
			principalType: "service",
			subject: input.subject,
		};
	}

	test("a session's own creator passes", () => {
		const only = principal({ subject: "visitor-1", environmentId: "env-1" });
		expect(() =>
			assertCallerOwnsSession({ current: only, initiator: only }),
		).not.toThrow();
	});

	test("the same visitor continuing on a later request passes", () => {
		expect(() =>
			assertCallerOwnsSession({
				current: principal({ subject: "visitor-1", environmentId: "env-1" }),
				initiator: principal({ subject: "visitor-1", environmentId: "env-1" }),
			}),
		).not.toThrow();
	});

	test("another environment's token cannot continue the session", () => {
		expect(() =>
			assertCallerOwnsSession({
				current: principal({ subject: "visitor-2", environmentId: "env-2" }),
				initiator: principal({ subject: "visitor-1", environmentId: "env-1" }),
			}),
		).toThrow(/different environment/);
	});

	test("a token naming no environment cannot continue a tenant's session", () => {
		expect(() =>
			assertCallerOwnsSession({
				current: principal({ subject: "visitor-1" }),
				initiator: principal({ subject: "visitor-1", environmentId: "env-1" }),
			}),
		).toThrow(/different environment/);
	});

	test("another identified visitor cannot continue the session", () => {
		expect(() =>
			assertCallerOwnsSession({
				current: principal({ subject: "visitor-2", environmentId: "env-1" }),
				initiator: principal({ subject: "visitor-1", environmentId: "env-1" }),
			}),
		).toThrow(/different visitor/);
	});

	test("anonymous visitors share a subject, so only the environment separates them", () => {
		expect(() =>
			assertCallerOwnsSession({
				current: principal({ subject: "anonymous", environmentId: "env-1" }),
				initiator: principal({ subject: "anonymous", environmentId: "env-1" }),
			}),
		).not.toThrow();
	});

	test("an anonymous caller cannot continue an identified visitor's session", () => {
		expect(() =>
			assertCallerOwnsSession({
				current: principal({ subject: "anonymous", environmentId: "env-1" }),
				initiator: principal({ subject: "visitor-1", environmentId: "env-1" }),
			}),
		).toThrow(/different visitor/);
	});

	test("a visitor identifying mid-conversation has to start a new session", () => {
		expect(() =>
			assertCallerOwnsSession({
				current: principal({ subject: "visitor-1", environmentId: "env-1" }),
				initiator: principal({ subject: "anonymous", environmentId: "env-1" }),
			}),
		).toThrow(/different visitor/);
	});
});
