import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { ROOT } from "./constants.js";

export function isHostnameLike(host) {
  if (!host) return false;
  if (host === "localhost") return false;
  if (host === "0.0.0.0" || host === "::") return false;
  if (host.startsWith("[") && host.endsWith("]")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (/^[0-9a-f:]+$/i.test(host) && host.includes(":")) return false;
  if (!host.includes(".")) return false;
  if (host.endsWith(".local")) return false;
  return true;
}

async function loadAcmeClient() {
  try {
    const acme = await import("acme-client");
    return { acme: acme.default ?? acme };
  } catch (error) {
    return { error };
  }
}

function readPemIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function loadCachedCert(cacheDir) {
  const cert = readPemIfExists(path.join(cacheDir, "cert.pem"));
  const key = readPemIfExists(path.join(cacheDir, "key.pem"));
  if (!cert || !key) return null;
  try {
    const x509 = new crypto.X509Certificate(cert);
    return { cert, key, expiry: new Date(x509.validTo) };
  } catch (_parseError) {
    return null;
  }
}

function writeCertCache(cacheDir, { cert, key }) {
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(cacheDir, "cert.pem"), cert, { mode: 0o644 });
  fs.writeFileSync(path.join(cacheDir, "key.pem"), key, { mode: 0o600 });
}

async function loadOrCreateAccountKey(acme, cacheDir) {
  const accountKeyPath = path.join(cacheDir, "account.key");
  if (fs.existsSync(accountKeyPath)) {
    return fs.readFileSync(accountKeyPath, "utf8");
  }
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const accountKey = await acme.crypto.createPrivateRsaKey();
  const pem = Buffer.isBuffer(accountKey)
    ? accountKey.toString("utf8")
    : String(accountKey);
  fs.writeFileSync(accountKeyPath, pem, { mode: 0o600 });
  return pem;
}

async function provisionCert({
  acme,
  domain,
  email,
  cacheDir,
  staging,
  challengeMap,
}) {
  const accountKey = await loadOrCreateAccountKey(acme, cacheDir);
  const directoryUrl = staging
    ? acme.directory.letsencrypt.staging
    : acme.directory.letsencrypt.production;

  const client = new acme.Client({ directoryUrl, accountKey });
  const [domainKey, csr] = await acme.crypto.createCsr({ altNames: [domain] });

  console.log(
    `[acme] requesting ${staging ? "staging" : "production"} certificate for ${domain}…`,
  );
  const cert = await client.auto({
    csr,
    email: email || undefined,
    termsOfServiceAgreed: true,
    challengePriority: ["http-01"],
    challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
      if (challenge.type === "http-01") {
        challengeMap.set(challenge.token, keyAuthorization);
      }
    },
    challengeRemoveFn: async (_authz, challenge) => {
      if (challenge.type === "http-01") {
        challengeMap.delete(challenge.token);
      }
    },
  });

  const certPem = Buffer.isBuffer(cert) ? cert.toString("utf8") : String(cert);
  const keyPem = Buffer.isBuffer(domainKey)
    ? domainKey.toString("utf8")
    : String(domainKey);
  writeCertCache(cacheDir, { cert: certPem, key: keyPem });
  const x509 = new crypto.X509Certificate(certPem);
  const expiry = new Date(x509.validTo);
  console.log(`[acme] certificate provisioned (expires ${expiry.toISOString()})`);
  return { cert: certPem, key: keyPem, expiry };
}

function startAcmeChallengeListener({
  challengeMap,
  challengePort,
  redirectHttpsPort,
}) {
  const handler = (request, response) => {
    if (request.url.startsWith("/.well-known/acme-challenge/")) {
      const token = request.url.split("/").pop();
      const keyAuthorization = challengeMap.get(token);
      if (keyAuthorization) {
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
        });
        response.end(keyAuthorization);
        return;
      }
      response.writeHead(404).end();
      return;
    }
    const hostHeader = (request.headers.host ?? "").split(":")[0];
    const portSuffix =
      redirectHttpsPort && redirectHttpsPort !== 443
        ? `:${redirectHttpsPort}`
        : "";
    response.writeHead(308, {
      Location: `https://${hostHeader}${portSuffix}${request.url}`,
    });
    response.end();
  };
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(challengePort, "0.0.0.0", () => {
      console.log(
        `[acme] HTTP-01 challenge + HTTP→HTTPS redirect listener on :${challengePort}`,
      );
      resolve(server);
    });
  });
}

export function scheduleAcmeRenewal({ initialExpiry, renewFn, applyFn }) {
  const renewLeadMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  const minDelay = 60 * 1000;
  const retryDelay = 60 * 60 * 1000; // 1 hour after failure
  let timer = null;

  const arm = (expiry) => {
    const target = expiry.getTime() - renewLeadMs;
    const delay = Math.max(minDelay, target - Date.now());
    timer = setTimeout(async () => {
      try {
        const result = await renewFn();
        applyFn(result);
        arm(result.expiry);
      } catch (error) {
        console.error(
          `[acme] renewal failed: ${error.message}. Retrying in 1 hour.`,
        );
        timer = setTimeout(() => arm(expiry), retryDelay);
      }
    }, delay);
    timer.unref?.();
  };

  arm(initialExpiry);
  return () => {
    if (timer) clearTimeout(timer);
  };
}

export async function setupAutoTls({ host, port, options }) {
  const explicitDomain = options.domain ? String(options.domain) : null;
  const domain = explicitDomain ?? (isHostnameLike(host) ? host : null);
  if (!domain) {
    return null;
  }

  const acmeResult = await loadAcmeClient();
  if (acmeResult.error) {
    throw new Error(
      `Auto-TLS for '${domain}' requires the acme-client package. ` +
        "Run `npm install` in the repo root, or bind to an IP/localhost for plain HTTP.\n" +
        `  reason: ${acmeResult.error.message}`,
    );
  }
  const { acme } = acmeResult;

  const acmeCacheRoot = options["acme-cache"]
    ? path.resolve(String(options["acme-cache"]))
    : path.join(ROOT, ".acme");
  const cacheDir = path.join(acmeCacheRoot, domain);
  const staging = Boolean(options["acme-staging"]);
  const email = options["acme-email"] ? String(options["acme-email"]) : null;
  const challengePort = Number(options["acme-challenge-port"] ?? 80);

  const challengeMap = new Map();
  const challengeServer = await startAcmeChallengeListener({
    challengeMap,
    challengePort,
    redirectHttpsPort: port,
  });

  const renewLeadDays = 30;
  const cached = loadCachedCert(cacheDir);
  let bundle = null;
  if (cached) {
    const daysLeft =
      (cached.expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    if (daysLeft > renewLeadDays) {
      console.log(
        `[acme] using cached certificate for ${domain} (expires in ${Math.floor(daysLeft)} days)`,
      );
      bundle = cached;
    } else {
      console.log(
        `[acme] cached cert near expiry (${Math.floor(daysLeft)} days remaining); renewing`,
      );
    }
  }
  if (!bundle) {
    bundle = await provisionCert({
      acme,
      domain,
      email,
      cacheDir,
      staging,
      challengeMap,
    });
  }

  return {
    domain,
    bundle,
    challengeServer,
    renew: () =>
      provisionCert({
        acme,
        domain,
        email,
        cacheDir,
        staging,
        challengeMap,
      }),
  };
}
