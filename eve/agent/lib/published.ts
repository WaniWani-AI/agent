import { listMcpTools, type McpTool } from "./mcp-catalog.js";
import {
	ConfigFetchError,
	fetchSessionConfig,
	type SessionConfig,
} from "./session-config.js";
import type { Tenant } from "./tenant.js";
import { timing } from "./turn-timing.js";
import { waitUntil } from "./wait-until.js";

export type Published = { config: SessionConfig; tools: McpTool[] };

type Entry = {
	published?: Published;
	etag?: string;
	checkedAt: number;
	confirmedAt?: number;
	lastError?: string;
};

const REVALIDATE_AFTER_MS = 60_000;
const MAX_STALE_MS = 10 * 60_000;

const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<Published>>();

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : "unknown error";
}

function fresh(entry: Entry | undefined): boolean {
	return entry !== undefined && Date.now() - entry.checkedAt < REVALIDATE_AFTER_MS;
}

function servable(entry: Entry | undefined): Published | undefined {
	return entry?.confirmedAt !== undefined && Date.now() - entry.confirmedAt <= MAX_STALE_MS
		? entry.published
		: undefined;
}

/** The app answers 404 once the agent is unpublished or its environment is gone. */
function withdrawn(error: unknown): boolean {
	return error instanceof ConfigFetchError && error.status === 404;
}

/** The prompt describes the tools, so the config and the tool list only ever move together. */
async function refresh(tenant: Tenant): Promise<Published> {
	const previous = entries.get(tenant.key);
	const attempt: Entry = { ...previous, checkedAt: Date.now() };
	entries.set(tenant.key, attempt);

	try {
		const startedAt = Date.now();
		const fetched = await fetchSessionConfig({
			tenant,
			previous:
				previous?.etag && previous.published
					? { etag: previous.etag, value: previous.published.config }
					: undefined,
		});
		const configMs = Date.now() - startedAt;
		const tools = await listMcpTools({
			tenantKey: tenant.key,
			mcpUrl: fetched.value.mcpUrl,
		});
		timing("published.refresh", {
			tenant: tenant.key,
			configMs,
			toolsMs: Date.now() - startedAt - configMs,
			notModified: fetched.value === previous?.published?.config,
		});
		const published: Published = { config: fetched.value, tools };
		entries.set(tenant.key, {
			published,
			etag: fetched.etag,
			checkedAt: attempt.checkedAt,
			confirmedAt: attempt.checkedAt,
		});
		return published;
	} catch (error) {
		entries.set(
			tenant.key,
			withdrawn(error)
				? { checkedAt: attempt.checkedAt, lastError: messageOf(error) }
				: { ...attempt, lastError: messageOf(error) },
		);
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

/** What a turn resolves against: memory when warm, a blocking pass when cold or too stale. */
export async function publishedNow(tenant: Tenant): Promise<Published> {
	const entry = entries.get(tenant.key);
	const published = servable(entry);
	if (published) {
		revalidatePublished(tenant);
		return published;
	}
	if (fresh(entry) && !inflight.has(tenant.key)) {
		throw new Error(
			`No published configuration for this agent: ${entry?.lastError ?? "unknown error"}`,
		);
	}
	return await shared(tenant);
}

export function cacheState(tenant: Tenant): "warm" | "stale" | "cold" {
	const entry = entries.get(tenant.key);
	if (!servable(entry)) return "cold";
	return fresh(entry) ? "warm" : "stale";
}

export function revalidatePublished(tenant: Tenant): void {
	if (fresh(entries.get(tenant.key)) || inflight.has(tenant.key)) {
		return;
	}
	waitUntil(
		shared(tenant).catch((error: unknown) => {
			console.error("[published] revalidation failed", {
				tenant: tenant.key,
				message: messageOf(error),
			});
		}),
	);
}

export function resetPublished(): void {
	entries.clear();
	inflight.clear();
}
