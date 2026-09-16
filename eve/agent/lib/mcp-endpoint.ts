/** The app stores an environment's URL as the full endpoint, `/mcp` included. */
export function mcpEndpointFor(mcpUrl: string): string {
	const base = (process.env.WANIWANI_MCP_URL || mcpUrl).replace(/\/+$/, "");
	return base.endsWith("/mcp") ? base : `${base}/mcp`;
}
