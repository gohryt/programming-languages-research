#!/usr/bin/env node

import { ensureDirectory } from "./lib/util.js";
import { DATA_DIR, SUMMARY_DIR } from "./lib/constants.js";
import { commandServe } from "./lib/serve.js";

function parseValue(rawValue) {
  if (rawValue === undefined) {
    return true;
  }
  return rawValue;
}

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const optionName = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options[optionName] = parseValue(next);
        index += 1;
      } else {
        options[optionName] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

function printUsage() {
  console.log(`Usage: node source/research.js [options]

Validates data/ against the schema, rebuilds summary/data.json, and serves
the static UI together with the MCP endpoint at /mcp (POST). Records are
edited directly in data/*.json (use git for change management).

Options:
  --check               validate only and exit. No server, no write.
                        Suitable for pre-commit hooks or CI gating.
  --host HOST           bind interface. Default 127.0.0.1. If this looks
                        like a public hostname (or --domain is set), TLS
                        is provisioned automatically via Let's Encrypt.
  --port PORT           listen port. Default 8000.
  --no-mcp              serve only the static UI (skip MCP).
  --allowed-host a,b,c  Host header allow-list (DNS-rebinding protection).

  --domain D            cert hostname when binding to a different --host
                        (e.g. --host 0.0.0.0 --domain example.com).
  --acme-email E        contact email for the ACME account (recommended).
  --acme-cache DIR      cert cache directory (default ./.acme/<domain>/).
  --acme-staging        use the Let's Encrypt staging endpoint for testing.
  --acme-challenge-port N  HTTP-01 listener port (default 80).

  --help                show this message.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const { positional: _positional, options } = parseArguments(argv);
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
