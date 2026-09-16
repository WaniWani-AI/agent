import { readFile, writeFile } from "node:fs/promises";

// Eve 0.53.0 bundles Workflow core. Postgres serializes workflow invocations,
// so a long inline model step blocks the replay that delivers its abort signal.
// Allow zero inline steps until this is supported upstream. Re-evaluate this
// patch on every Eve upgrade; do not silently ship without prompt cancellation.
const root = new URL("../node_modules/eve/", import.meta.url);
const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
if (version !== "0.53.0") {
	throw new Error(`Review the workflow cancellation patch before using Eve ${version}`);
}
const path = new URL("dist/src/compiled/@workflow/core/runtime.js", root);
const source = await readFile(path, "utf8");
const original = "let e=process.env.WORKFLOW_MAX_INLINE_STEPS;";
const patched = original + 'if(e==="0")return 0;';
if (source.split(original).length !== 2) {
	throw new Error("Workflow inline-step parser changed; review the cancellation patch");
}
if (!source.includes(patched)) {
	await writeFile(path, source.replace(original, patched));
}
