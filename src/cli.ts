#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startServer } from "./index.js";

// Loud, not silent: an uncaught rejection anywhere in the process otherwise
// exits with a bare stack trace (or, pre-Node 15, is swallowed entirely).
process.on("unhandledRejection", (reason) => {
  console.error("unhandled rejection:", reason);
  process.exit(1);
});

const USAGE = `Usage:
  caching-proxy --port <number> --origin <url>
  caching-proxy --clear-cache [--port <number>]`;

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port: ${value}`);
  }
  return port;
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
    "clear-cache"?: boolean;
  };
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: "string" },
        origin: { type: "string" },
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

  let port: number;
  try {
    port = parsePort(values.port);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  try {
    new URL(values.origin);
  } catch {
    console.error(`invalid --origin: ${values.origin}`);
    process.exit(1);
  }

  startServer({ port, origin: values.origin });
}

main();
