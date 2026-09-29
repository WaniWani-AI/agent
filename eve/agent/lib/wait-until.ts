type RequestContext = { waitUntil?: (promise: Promise<unknown>) => void };

/**
 * What `@vercel/functions` reads to keep an invocation alive after it answers.
 * Off Vercel the process outlives the promise anyway.
 */
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

function requestContext(): RequestContext | undefined {
	const holder: unknown = Reflect.get(globalThis, REQUEST_CONTEXT);
	if (typeof holder !== "object" || holder === null || !("get" in holder)) return undefined;
	const get = holder.get;
	if (typeof get !== "function") return undefined;
	const context: unknown = get.call(holder);
	return typeof context === "object" && context !== null ? context : undefined;
}

export function waitUntil(promise: Promise<unknown>): void {
	const settled = promise.catch(() => {});
	requestContext()?.waitUntil?.(settled);
}
