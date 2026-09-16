import { afterEach, describe, expect, test } from "bun:test";
import { mcpEndpointFor } from "./mcp-endpoint.js";

describe("mcpEndpointFor", () => {
	afterEach(() => {
		delete process.env.WANIWANI_MCP_URL;
	});

	test("an environment URL already carrying /mcp is left alone", () => {
		expect(mcpEndpointFor("http://localhost:3001/mcp")).toBe(
			"http://localhost:3001/mcp",
		);
	});

	test("a bare origin gets /mcp appended", () => {
		expect(mcpEndpointFor("http://mcp:3002")).toBe("http://mcp:3002/mcp");
	});

	test("a trailing slash does not produce a double slash", () => {
		expect(mcpEndpointFor("http://mcp:3002/")).toBe("http://mcp:3002/mcp");
	});

	test("the override wins and follows the same rule", () => {
		process.env.WANIWANI_MCP_URL = "http://host.docker.internal:3001/mcp";
		expect(mcpEndpointFor("http://ignored:1/mcp")).toBe(
			"http://host.docker.internal:3001/mcp",
		);
		process.env.WANIWANI_MCP_URL = "http://host.docker.internal:3001";
		expect(mcpEndpointFor("http://ignored:1/mcp")).toBe(
			"http://host.docker.internal:3001/mcp",
		);
	});
});
