import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

// The hosted stack needs an Ed25519 pair: eve signs the service token, the mock
// app verifies it. Generated per run so no private key is ever committed.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
mkdirSync(new URL("keys/", import.meta.url), { recursive: true });
writeFileSync(
	new URL("keys/service.key", import.meta.url),
	privateKey.export({ type: "pkcs8", format: "pem" }),
);
writeFileSync(
	new URL("keys/service.pub", import.meta.url),
	publicKey.export({ type: "spki", format: "pem" }),
);
writeFileSync(new URL("keys/.gitignore", import.meta.url), "*\n");
console.log(`[ci] wrote a throwaway service keypair (${randomUUID().slice(0, 8)})`);
