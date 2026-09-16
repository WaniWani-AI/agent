FROM oven/bun:1.3-slim
WORKDIR /app
COPY fixtures/package.json fixtures/bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY fixtures ./fixtures
# The adapter's source, so the MCP fixture can mount its router the way the
# template will. Paths match the repository, so the same command runs locally.
COPY packages/adapter ./packages/adapter
