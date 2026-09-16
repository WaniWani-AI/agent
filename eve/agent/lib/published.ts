import { listMcpTools, type McpTool } from "./mcp-catalog.js";
import { fetchSessionConfig, type SessionConfig } from "./session-config.js";
import type { Tenant } from "./tenant.js";

export type Published = { config: SessionConfig; tools: McpTool[] };

type Entry = {
	published?: Published;
	etag?: string;
	checkedAt: number;
	lastError?: string;
};

const REVALIDATE_AFTER_MS = 60_000;

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<Published>>();

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : "unknown error";
}

function fresh(entry: Entry | undefined): boolean {
	return entry !== undefined && Date.now() - entry.checkedAt < REVALIDATE_AFTER_MS;
}

/** The prompt describes the tools, so the config and the tool list only ever move together. */
async function refresh(tenant: Tenant): Promise<Published> {
	const previous = entries.get(tenant.key);
	const attempt: Entry = { ...previous, checkedAt: Date.now() };
	entries.set(tenant.key, attempt);

	try {
		const fetched = await fetchSessionConfig({
			tenant,
			previous:
				previous?.etag && previous.published
					? { etag: previous.etag, value: previous.published.config }
					: undefined,
		});
		const tools = await listMcpTools({
			tenantKey: tenant.key,
			mcpUrl: fetched.value.mcpUrl,
		});
		const published: Published = { config: fetched.value, tools };
		entries.set(tenant.key, {
			published,
			etag: fetched.etag,
			checkedAt: attempt.checkedAt,
		});
		return published;
	} catch (error) {
		entries.set(tenant.key, { ...attempt, lastError: messageOf(error) });
		throw error;
	}
}

function shared(tenant: Tenant): Promise<Published> {
	let pass = inflight.get(tenant.key);
	if (!pass) {
		pass = refresh(tenant).finally(() => {
			inflight.delete(tenant.key);
		});
		inflight.set(tenant.key, pass);
	}
	return pass;
}

/** What a turn resolves against: memory when warm, a blocking pass only when cold. */
export async function publishedNow(tenant: Tenant): Promise<Published> {
	const entry = entries.get(tenant.key);
	if (entry?.published) {
		revalidatePublished(tenant);
		return entry.published;
	}
	if (fresh(entry) && !inflight.has(tenant.key)) {
		throw new Error(
			`No published configuration for this agent: ${entry?.lastError ?? "unknown error"}`,
		);
	}
	return await shared(tenant);
}

export function revalidatePublished(tenant: Tenant): void {
	if (fresh(entries.get(tenant.key)) || inflight.has(tenant.key)) {
		return;
	}
	void shared(tenant).catch((error: unknown) => {
		console.error("[published] revalidation failed", {
			tenant: tenant.key,
			message: messageOf(error),
		});
	});
}

export function resetPublished(): void {
	entries.clear();
	inflight.clear();
}
