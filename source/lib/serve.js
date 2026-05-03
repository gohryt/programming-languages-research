import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { SUMMARY_DIR } from "./constants.js";
import { parseCommaSeparated } from "./util.js";
import { validateAndBuild, writeSummaryBundle } from "./summary.js";
import { loadMcpModules, buildMcpServer } from "./mcp.js";
import { setupAutoTls, scheduleAcmeRenewal } from "./acme.js";

function readJsonBody(request, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("Request body exceeds size limit"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text) {
          resolve(null);
          return;
        }
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function applyMcpCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader(
    "Access-Control-Allow-Methods",
    "POST, GET, DELETE, OPTIONS",
  );
  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Mcp-Session-Id, Last-Event-ID, Authorization",
  );
  response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function checkAllowedHost(request, allowedHosts) {
  if (allowedHosts.length === 0) return true;
  const hostHeader = request.headers.host ?? "";
  const hostname = hostHeader.split(":")[0];
  return allowedHosts.some(
    (allowed) => allowed === hostname || allowed === hostHeader,
  );
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

export async function commandServe(options) {
  const port = Number(options.port ?? 8000);
  const host = String(options.host ?? "127.0.0.1");
  const mcpDisabled = Boolean(options["no-mcp"]);
  const checkOnly = Boolean(options.check);

  const allowedHosts = parseCommaSeparated(
    options["allowed-host"] ?? options["allowed-hosts"] ?? "",
  );

  const { bundle, warnings, recordCount, tagCount } = validateAndBuild();
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }
  console.log(
    `Validated ${recordCount} record(s), ${tagCount} tag descriptor(s).`,
  );
  if (checkOnly) {
    return;
  }

  writeSummaryBundle(bundle, {});

  const acmeContext = await setupAutoTls({ host, port, options });
  let tlsMode = "none";
  let tlsContext = null;
  if (acmeContext) {
    tlsMode = "auto";
    tlsContext = {
      cert: acmeContext.bundle.cert,
      key: acmeContext.bundle.key,
    };
  }

  const getBundle = () => bundle;

  let mcp = null;
  if (!mcpDisabled) {
    const loaded = await loadMcpModules();
    if (loaded.error) {
      console.warn(
        "[mcp] SDK not available; /mcp endpoint disabled. Run `npm install` in the repo root to enable it.",
      );
      console.warn(`[mcp] reason: ${loaded.error.message}`);
    } else {
      mcp = loaded;
    }
  }

  const requestHandler = async (request, response) => {
    if (!checkAllowedHost(request, allowedHosts)) {
      response.writeHead(403, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      response.end("Forbidden host");
      return;
    }

    const url = new URL(request.url, `http://${host}:${port}`);
    let requestPath = decodeURIComponent(url.pathname);

    if (requestPath === "/mcp") {
      applyMcpCors(response);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed." },
            id: null,
          }),
        );
        return;
      }
      if (!mcp) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message:
                "MCP support not available. Install dependencies with `npm install` in the repository root.",
            },
            id: null,
          }),
        );
        return;
      }
      let body;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32700,
              message: `Parse error: ${error.message}`,
            },
            id: null,
          }),
        );
        return;
      }
      try {
        const mcpServer = buildMcpServer({
          McpServer: mcp.McpServer,
          ResourceTemplate: mcp.ResourceTemplate,
          z: mcp.z,
          getBundle,
        });
        const transport = new mcp.StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        response.on("close", () => {
          try {
            transport.close();
            mcpServer.close();
          } catch (_closeError) {
            // ignore close errors after the response is already finished
          }
        });
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, body);
      } catch (error) {
        console.error(`[mcp] request error: ${error.stack ?? error.message}`);
        if (!response.headersSent) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32603,
                message: String(error.message ?? error),
              },
              id: null,
            }),
          );
        }
      }
      return;
    }

    if (requestPath === "/") {
      requestPath = "/index.html";
    }
    const safePath = path.normalize(requestPath).replace(/^\/+/, "");
    const filePath = path.join(SUMMARY_DIR, safePath);
    if (!filePath.startsWith(SUMMARY_DIR)) {
      response.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": contentTypeFor(filePath) });
    fs.createReadStream(filePath).pipe(response);
  };

  const server =
    tlsMode === "none"
      ? http.createServer(requestHandler)
      : https.createServer(
          { cert: tlsContext.cert, key: tlsContext.key },
          requestHandler,
        );

  if (tlsMode === "auto" && acmeContext) {
    scheduleAcmeRenewal({
      initialExpiry: acmeContext.bundle.expiry,
      renewFn: acmeContext.renew,
      applyFn: ({ cert, key, expiry }) => {
        server.setSecureContext({ cert, key });
        console.log(
          `[acme] certificate renewed and applied (next expiry ${expiry.toISOString()})`,
        );
      },
    });
  }

  const cleanShutdown = () => {
    server.close(() => process.exit(0));
    if (acmeContext?.challengeServer) {
      acmeContext.challengeServer.close();
    }
  };
  process.on("SIGINT", cleanShutdown);
  process.on("SIGTERM", cleanShutdown);

  server.listen(port, host, () => {
    const proto = tlsMode === "none" ? "http" : "https";
    console.log(`Serving ${SUMMARY_DIR}`);
    console.log(`Open ${proto}://${host}:${port}`);
    if (mcp) {
      console.log(`MCP endpoint: ${proto}://${host}:${port}/mcp (POST)`);
    } else if (mcpDisabled) {
      console.log("MCP endpoint disabled by --no-mcp.");
    }
    if (tlsMode === "auto" && acmeContext) {
      console.log(`TLS: auto (Let's Encrypt) for ${acmeContext.domain}`);
    } else {
      console.log("TLS: off (plain HTTP)");
    }
    if (allowedHosts.length > 0) {
      console.log(`Host header allow-list: ${allowedHosts.join(", ")}`);
    }
  });
}
