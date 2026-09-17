# @waniwani/agent-adapter

Turns a WaniWani agent runtime session into a UI message stream, and serves the `/agent/v1` routes
an MCP server mounts.

This package is what a browser talks to. It turns a runtime session into the AI SDK UI message
stream that the WaniWani SDK's chat embed already reads, and it ships the routes that embed
expects.

> **Prerelease.** The `0.1.0-beta` line goes out while the runtime settles. Pin an exact version,
> because the `beta` dist-tag moves with every release.

## Install

```sh
npm install --save-exact @waniwani/agent-adapter@beta
```

Node 24 or newer. `jose` is the only dependency. `express`, `cors` and `@modelcontextprotocol/sdk`
are peers, which an MCP server built on Skybridge already has.

## `@waniwani/agent-adapter/express`

The router an MCP server mounts beside its own `/mcp`.

```ts
import express from "express";
import { agentRouter } from "@waniwani/agent-adapter/express";

const app = express();

app.use(
  "/agent/v1",
  agentRouter({
    eveUrl: process.env.WANIWANI_AGENT_EVE_URL!,
    apiKey: process.env.WANIWANI_API_KEY!,
    publicKey: process.env.WANIWANI_PUBLIC_KEY!,
    allowedOrigins: ["https://example.com"],
    title: "Example",
    mcpLoopbackUrl: "http://127.0.0.1:3000/mcp",
  }),
);
```

| Option | What it holds | Template variable |
| --- | --- | --- |
| `eveUrl` | Where the agent runtime listens. This doubles as the switch: leave it unset and nothing mounts. | `WANIWANI_AGENT_EVE_URL` |
| `apiKey` | The environment key (`wwk_…`) the server already holds. It never reaches a browser. | `WANIWANI_API_KEY` |
| `publicKey` | The environment's public key (`wwp_…`), which is what browsers present. | `WANIWANI_PUBLIC_KEY` |
| `allowedOrigins` | Exact origins allowed to post. No wildcards, no suffix matching. | `WANIWANI_ALLOWED_ORIGINS`, comma separated |
| `title` | The app's own title. | |
| `mcpLoopbackUrl` | This same process's `/mcp` route. | |

It serves `POST /` (the turn), `POST /cancel`, `GET /config`, `GET /tools`, `POST /tool`,
`GET /resource`, `POST /events` and `GET /health`. Browsers present the environment's public key,
compared in constant time. `GET /resource` also takes that key as `?token=`, because an iframe
navigates by GET and cannot carry a header. Every non-GET request has to carry an `Origin` on the
allowlist, and a client gets sixty requests a minute. The router presents the environment key to
the runtime, and never the browser's key.

## `@waniwani/agent-adapter/core`

Framework-free, and what a WaniWani-hosted chat route calls in process.

```ts
mintSessionToken({ secret, sub, environmentId?, channelId?, sid? }): Promise<string>
runTurn({ eveUrl, credential, visitorId?, message, sessionId?, clientContext?, extra?, signal? })
cancelTurn({ eveUrl, credential, sessionId }): Promise<void>
runtimeHealth({ eveUrl, credential }): Promise<unknown>
encodeSse(chunks): ReadableStream<Uint8Array>
```

`runTurn` answers `{ sessionId, chunks, cancel }` as soon as the runtime has taken the turn, and
the chunks arrive as the model writes them. `credential` is the environment key on a self-hosted
deployment. On the hosted one it is a function, because a hosted token names the single session it
may address and the adapter only learns that id once the session exists.

Call the returned `cancel()` for disconnect cleanup. It targets only that response's turn. The
standalone `cancelTurn({ sessionId, ... })` stops whatever turn the session is running, which is
what the Stop button does.

## Documentation

The runtime, its deployment and the operator guide live in
[WaniWani-AI/agent](https://github.com/WaniWani-AI/agent).

## License

[Apache-2.0](./LICENSE)
