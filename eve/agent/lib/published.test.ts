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
const START = Date.parse("2026-09-14T09:00:00.000Z");

const API_URL = "https://app.test.invalid";
const CONFIG_PATH = "/api/mcp/agent/config";
const MCP_URL = "http://mcp.test.invalid:3002";

// A real Ed25519 key, so the hosted path mints its service token without a network.
const SERVICE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIDxJlf0Lueua1UGrOO6qrMQZurg7sx7VX2z5sdRWCpp0
-----END PRIVATE KEY-----`;

type Recorded = {
	url: string;
	ifNoneMatch: string | null;
	authorization: string | null;
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

const { publishedNow, revalidatePublished, resetPublished } = await import(
	"./published.js"
);
const { tenantOf } = await import("./tenant.js");

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
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		setSystemTime();
		delete process.env.WANIWANI_SERVICE_PRIVATE_KEY;
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
		delete process.env.WANIWANI_SERVICE_PRIVATE_KEY;
		await publishedNow(SELF);

		const call = configCalls()[0];
		expect(call?.url).not.toContain("environmentId=");
		expect(call?.authorization).toBe("Bearer wwk_unit");
	});

	test("an incomplete payload fails rather than serving a blank prompt", async () => {
		reply = () =>
			new Response(
				JSON.stringify({ success: true, message: "success", data: {} }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		await expect(publishedNow(ALPHA)).rejects.toThrow(/incomplete/);
	});
});

describe("tenantOf", () => {
	afterEach(() => {
		delete process.env.WANIWANI_SERVICE_PRIVATE_KEY;
	});

	function auth(attributes: Record<string, string>) {
		return {
			current: null,
			initiator: {
				attributes,
				authenticator: "jwt-hmac",
				principalId: "waniwani:agent:visitor",
				principalType: "service",
				subject: "visitor",
			},
		};
	}

	test("a claimed environment is the tenant key on a hosted runtime", () => {
		process.env.WANIWANI_SERVICE_PRIVATE_KEY = SERVICE_KEY;
		expect(tenantOf(auth({ environmentId: "env-1" }))).toEqual({
			key: "env-1",
			environmentId: "env-1",
		});
	});

	test("no claim is the self tenant on a key-holding runtime", () => {
		expect(tenantOf(auth({}))).toEqual({ key: "self" });
	});

	test("a claimed environment on a key-holding runtime fails the turn", () => {
		expect(() => tenantOf(auth({ environmentId: "env-1" }))).toThrow(
			/WANIWANI_API_KEY/,
		);
	});

	test("no claim on a hosted runtime fails the turn", () => {
		process.env.WANIWANI_SERVICE_PRIVATE_KEY = SERVICE_KEY;
		expect(() => tenantOf(auth({}))).toThrow(/WANIWANI_SERVICE_PRIVATE_KEY/);
	});
});
