import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

// The hosted stack needs two pairs. Ed25519: eve signs the service token, the mock
// app verifies it. P-256: the e2e test signs visitor tokens as the app would, eve
// and the mock app verify them. Generated per run so no private key is ever committed.
mkdirSync(new URL("keys/", import.meta.url), { recursive: true });

function write(name, { privateKey, publicKey }) {
	writeFileSync(new URL(`keys/${name}.key`, import.meta.url), privateKey.export({ type: "pkcs8", format: "pem" }));
	writeFileSync(new URL(`keys/${name}.pub`, import.meta.url), publicKey.export({ type: "spki", format: "pem" }));
}

write("service", generateKeyPairSync("ed25519"));
write("app", generateKeyPairSync("ec", { namedCurve: "P-256" }));
writeFileSync(new URL("keys/.gitignore", import.meta.url), "*\n");
console.log(`[ci] wrote throwaway service and app keypairs (${randomUUID().slice(0, 8)})`);
