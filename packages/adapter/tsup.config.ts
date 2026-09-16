import { defineConfig } from "tsup";

export default defineConfig({
	clean: true,
	dts: true,
	entry: ["src/core.ts", "src/express.ts"],
	format: ["esm"],
	target: "node24",
});
