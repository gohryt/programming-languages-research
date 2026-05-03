#!/usr/bin/env node

import { parseArgs } from "node:util";
import { ensureDirectory } from "./lib/util.js";
import { DATA_DIR, SUMMARY_DIR } from "./lib/constants.js";
import { commandServe } from "./lib/serve.js";

function printUsage() {
  console.log(`Usage: node source/research.js [options]

Validates data/ against the schema, rebuilds summary/data.json, and serves
the static UI together with the MCP endpoint at /mcp (POST). Records are
edited directly in data/*.json (use git for change management).

Options:
  --check               validate only and exit. No server, no write.
                        Suitable for pre-commit hooks or CI gating.
  --host HOST           bind interface. Default 127.0.0.1. If it looks
                        like a public hostname, TLS is provisioned
                        automatically via Let's Encrypt.
  --port PORT           listen port. Default 8000.
  --allowed-host a,b,c  Host header allow-list (DNS-rebinding protection).
  --acme-email E        contact email for the ACME account (recommended).

  --help                show this message.
`);
}

async function main() {
  const { values: options } = parseArgs({
    args: process.argv.slice(2),
    options: {
      check: { type: "boolean" },
      host: { type: "string" },
      port: { type: "string" },
      "allowed-host": { type: "string" },
      "acme-email": { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (options.help) {
    printUsage();
    return;
  }

  ensureDirectory(DATA_DIR);
  ensureDirectory(SUMMARY_DIR);

  await commandServe(options);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
