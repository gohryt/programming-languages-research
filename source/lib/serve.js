import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import express from "express";
import cors from "cors";
import { SUMMARY_DIR } from "./constants.js";
import { parseCommaSeparated } from "./util.js";
import {
  validateAndBuild,
  writeSummaryBundle,
  preCompressSummary,
} from "./summary.js";
import { loadMcpModules, buildMcpServer } from "./mcp.js";
import { setupAutoTls, scheduleAcmeRenewal } from "./acme.js";

function jsonRpcError(response, status, code, message) {
  if (response.headersSent) return;
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function logMcpAccess(request, response, started, body) {
  const ms = Date.now() - started;
  const tool =
    body && typeof body === "object"
      ? body.method === "tools/call"
        ? body.params?.name
        : body.method
      : null;
  console.log(
    `[mcp] ${request.method} ${tool ?? "?"} → ${response.statusCode} (${ms}ms)`,
  );
}

function checkAllowedHost(allowedHosts) {
  return (request, response, next) => {
    if (allowedHosts.length === 0) return next();
    const hostHeader = request.headers.host ?? "";
    const hostname = hostHeader.split(":")[0];
    const ok = allowedHosts.some(
      (entry) => entry === hostname || entry === hostHeader,
    );
    if (ok) return next();
    response.status(403).type("text/plain").send("Forbidden host");
  };
}

function acceptsEncoding(request, encoding) {
  const header = request.headers["accept-encoding"];
  if (!header) return false;
  return String(header)
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => {
      const [name, ...parameters] = entry.split(";").map((part) => part.trim());
      if (name !== encoding && name !== "*") return false;
      const quality = parameters.find((parameter) =>
        parameter.startsWith("q="),
      );
      return !quality || Number(quality.slice(2)) > 0;
    });
}

function staticRequestPath(request) {
  try {
    const url = new URL(request.url, "http://localhost");
    const decodedPath = decodeURIComponent(url.pathname);
    return decodedPath.endsWith("/") ? `${decodedPath}index.html` : decodedPath;
  } catch (_error) {
    return null;
  }
}

function collectStaticFiles(root) {
  const filesByRequestPath = new Map();
  const visitDirectory = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visitDirectory(filePath);
        continue;
      }
      if (
        !entry.isFile() ||
        entry.name.endsWith(".gz") ||
        entry.name.endsWith(".br")
      ) {
        continue;
      }
      const relativePath = path
        .relative(root, filePath)
        .split(path.sep)
        .join("/");
      filesByRequestPath.set(`/${relativePath}`, {
        filePath,
        compressed: [
          { encoding: "br", filePath: `${filePath}.br` },
          { encoding: "gzip", filePath: `${filePath}.gz` },
        ].filter((variant) => fs.existsSync(variant.filePath)),
      });
    }
  };
  visitDirectory(root);
  return filesByRequestPath;
}

function servePrecompressedStatic(root) {
  const uncompressedStatic = express.static(root, { index: "index.html" });
  const filesByRequestPath = collectStaticFiles(root);
  return (request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return uncompressedStatic(request, response, next);
    }
    const requestPath = staticRequestPath(request);
    if (!requestPath) return next();
    const entry = filesByRequestPath.get(requestPath);
    if (!entry) {
      return uncompressedStatic(request, response, next);
    }

    for (const variant of entry.compressed) {
      if (!acceptsEncoding(request, variant.encoding)) continue;
      response.vary("Accept-Encoding");
      response.setHeader("Content-Encoding", variant.encoding);
      response.type(path.extname(entry.filePath));
      return response.sendFile(variant.filePath);
    }
    return uncompressedStatic(request, response, next);
  };
}

export async function commandServe(options) {
  const port = Number(options.port ?? 8000);
  const host = String(options.host ?? "127.0.0.1");
  const checkOnly = Boolean(options.check);

  const allowedHosts = parseCommaSeparated(options["allowed-host"] ?? "");

  const { bundle, warnings } = validateAndBuild();
  for (const warning of warnings) {
    console.warn(`Warning: ${warning}`);
  }
  const recordCount = Object.keys(bundle.records).length;
  const tagCount = Object.keys(bundle.tagDescriptors).length;
  console.log(
    `Validated ${recordCount} record(s), ${tagCount} tag descriptor(s).`,
  );
  if (checkOnly) {
    return;
  }

  writeSummaryBundle(bundle);
  preCompressSummary();

  const acmeContext = await setupAutoTls({ host, port, options });
  const tlsMode = acmeContext ? "auto" : "none";

  const getBundle = () => bundle;

  const mcpLoaded = await loadMcpModules();
  if (mcpLoaded.error) {
    console.warn(
      "[mcp] SDK not available; /mcp endpoint disabled. Run `npm install` in the repo root to enable it.",
    );
    console.warn(`[mcp] reason: ${mcpLoaded.error.message}`);
  }
  const mcp = mcpLoaded.error ? null : mcpLoaded;

  const app = express();
  app.disable("x-powered-by");
  app.use(checkAllowedHost(allowedHosts));

  const mcpCors = cors({
    origin: "*",
    methods: ["POST", "GET", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Mcp-Session-Id",
      "Last-Event-ID",
      "Authorization",
    ],
    exposedHeaders: ["Mcp-Session-Id"],
  });
  const mcpJson = express.json({ limit: "8mb" });

  app.use("/mcp", mcpCors);

  app.post(
    "/mcp",
    (request, response, next) => {
      // wrap mcpJson so its sync errors (entity.too.large, parse failure)
      // become JSON-RPC errors with the right HTTP status instead of HTML 500.
      mcpJson(request, response, (error) => {
        if (!error) return next();
        const started = Date.now();
        if (error.type === "entity.too.large") {
          jsonRpcError(response, 413, -32600, error.message);
        } else {
          jsonRpcError(response, 400, -32700, `Parse error: ${error.message}`);
        }
        logMcpAccess(request, response, started, null);
      });
    },
    async (request, response) => {
      const started = Date.now();
      if (!mcp) {
        jsonRpcError(
          response,
          503,
          -32603,
          "MCP support not available. Install dependencies with `npm install` in the repository root.",
        );
        logMcpAccess(request, response, started, null);
        return;
      }
      const body = request.body ?? null;
      try {
        const mcpServer = buildMcpServer({
          McpServer: mcp.McpServer,
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
        logMcpAccess(request, response, started, body);
      } catch (error) {
        console.error(`[mcp] request error: ${error.stack ?? error.message}`);
        jsonRpcError(response, 500, -32603, String(error.message ?? error));
        logMcpAccess(request, response, started, body);
      }
    },
  );

  app.all("/mcp", (request, response) => {
    const started = Date.now();
    jsonRpcError(response, 405, -32000, "Method not allowed.");
    logMcpAccess(request, response, started, null);
  });

  // Pre-compressed .br / .gz siblings are written by preCompressSummary before
  // the server starts. The static middleware rewrites only the file path it
  // passes to sendFile, so requests never pay runtime compression cost.
  app.use(servePrecompressedStatic(SUMMARY_DIR));

  app.use((_request, response) => {
    response.status(404).type("text/plain").send("Not found");
  });

  const server =
    tlsMode === "none"
      ? http.createServer(app)
      : https.createServer(
          { cert: acmeContext.bundle.cert, key: acmeContext.bundle.key },
          app,
        );

  server.on("error", (error) => {
    console.error(`Server error: ${error.message}`);
    process.exit(1);
  });

  if (tlsMode === "auto") {
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

  let shuttingDown = false;
  const cleanShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const closes = [new Promise((resolve) => server.close(() => resolve()))];
    if (acmeContext?.challengeServer) {
      closes.push(
        new Promise((resolve) =>
          acmeContext.challengeServer.close(() => resolve()),
        ),
      );
    }
    await Promise.all(closes);
    process.exit(0);
  };
  process.on("SIGINT", cleanShutdown);
  process.on("SIGTERM", cleanShutdown);

  server.listen(port, host, () => {
    const proto = tlsMode === "none" ? "http" : "https";
    console.log(`Serving ${SUMMARY_DIR}`);
    console.log(`Open ${proto}://${host}:${port}`);
    if (mcp) {
      console.log(`MCP endpoint: ${proto}://${host}:${port}/mcp (POST)`);
    }
    if (tlsMode === "auto") {
      console.log(`TLS: auto (Let's Encrypt) for ${acmeContext.domain}`);
    } else {
      console.log("TLS: off (plain HTTP)");
    }
    if (allowedHosts.length > 0) {
      console.log(`Host header allow-list: ${allowedHosts.join(", ")}`);
    }
  });
}
