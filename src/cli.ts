#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startServer, DEFAULT_CONFIG } from "./index.js";

// Loud, not silent: an uncaught rejection anywhere in the process otherwise
// exits with a bare stack trace (or, pre-Node 15, is swallowed entirely).
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
  process.exit(1);
});

const USAGE = `Usage:
  caching-proxy --port <number> --origin <url> [--timeout <ms>]
  caching-proxy --clear-cache [--port <number>]`;

// Wraps parse+validate+report-and-exit into one reusable definition, so each
// CLI flag (this one, and the Phase E flags still to come) is a 2–3 line
// call instead of its own hand-rolled parse/throw/catch/exit block.
function defineFlag<T>(
  name: string,
  parse: (raw: string) => T,
  validate: (value: T) => boolean,
): (raw: string) => T {
  return (raw) => {
    const value = parse(raw);
    if (!validate(value)) {
      console.error(`invalid ${name}: ${raw}`);
      process.exit(1);
    }
    return value;
  };
}

const parsePort = defineFlag("--port", Number, (n) => Number.isInteger(n) && n >= 1 && n <= 65535);
const parseTimeout = defineFlag("--timeout", Number, (n) => Number.isInteger(n) && n > 0);

const DRAIN_TIMEOUT_MS = 10_000;

// Stop accepting new connections and let in-flight requests finish on their
// own; if any are still open after the drain deadline, force them closed
// rather than hang forever waiting on a client that never comes back.
function shutdown(server: ReturnType<typeof startServer>): void {
  console.log("shutting down...");
  server.close(() => process.exit(0));
  setTimeout(() => {
    console.error(`drain deadline (${DRAIN_TIMEOUT_MS}ms) exceeded, forcing remaining connections closed`);
    server.closeAllConnections();
    process.exit(1);
  }, DRAIN_TIMEOUT_MS);
}

async function clearCache(portArg: string | undefined): Promise<void> {
  const port = portArg !== undefined ? parsePort(portArg) : 3000;
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/_cache`, { method: "DELETE" });
  } catch (err) {
    console.error(
      `could not reach caching proxy on port ${port}:`,
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  }
  const body = await res.text();
  if (!res.ok) {
    console.error(`clear-cache failed: ${res.status} ${body}`);
    process.exit(1);
  }
  console.log(body.trim());
}

async function main(): Promise<void> {
  let values: {
    port?: string;
    origin?: string;
    timeout?: string;
    "clear-cache"?: boolean;
  };
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: "string" },
        origin: { type: "string" },
        timeout: { type: "string" },
        "clear-cache": { type: "boolean" },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exit(1);
  }

  if (values["clear-cache"]) {
    await clearCache(values.port);
    return;
  }

  if (values.port === undefined || values.origin === undefined) {
    console.error("both --port and --origin are required");
    console.error(USAGE);
    process.exit(1);
  }

  const port = parsePort(values.port);

  try {
    new URL(values.origin);
  } catch {
    console.error(`invalid --origin: ${values.origin}`);
    process.exit(1);
  }

  const config = {
    ...DEFAULT_CONFIG,
    ...(values.timeout !== undefined && { timeoutMs: parseTimeout(values.timeout) }),
  };

  const server = startServer({ port, origin: values.origin, config });
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `port ${port} in use` : err.message);
    process.exit(1);
  });
  process.on("SIGINT", () => shutdown(server));
  process.on("SIGTERM", () => shutdown(server));
}

main();
