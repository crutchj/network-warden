import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import {
  extractCsrfToken,
  isAccessDeniedPage,
  isLoginPage,
  parseCpuLoadPage,
  parseGatewaysPage,
  parseInterfacesPage,
} from "./html.mjs";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ALLOWED_PATHS = new Set([
  "/",
  "/index.php",
  "/status_interfaces.php",
  "/status_gateways.php",
  "/status_cpuload.php",
]);

function normalizeFingerprint(value) {
  return value.replace(/[^0-9a-f]/gi, "").toUpperCase();
}

function assertPinnedFingerprint(expected, actual) {
  const normalizedExpected = normalizeFingerprint(expected);
  const normalizedActual = normalizeFingerprint(actual);
  if (normalizedExpected.length !== 64 || normalizedActual !== normalizedExpected) {
    throw new Error("The pfSense TLS certificate changed or did not match the trusted fingerprint.");
  }
}

function cookieValues(headers) {
  const values = headers["set-cookie"];
  if (!values) return [];
  return (Array.isArray(values) ? values : [values])
    .map((value) => value.split(";", 1)[0])
    .filter((value) => /^[^=\s]+=[^;]*$/.test(value));
}

function mergeCookies(cookieJar, headers) {
  for (const cookie of cookieValues(headers)) {
    const separator = cookie.indexOf("=");
    cookieJar.set(cookie.slice(0, separator), cookie.slice(separator + 1));
  }
}

function cookieHeader(cookieJar) {
  return [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function validateRequestPath(path) {
  const parsed = new URL(path, "https://pfsense.invalid");
  if (parsed.origin !== "https://pfsense.invalid" || !ALLOWED_PATHS.has(parsed.pathname)) {
    throw new Error("The collector refused a non-telemetry pfSense path.");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function telemetryRequest({
  target,
  path,
  method = "GET",
  body = null,
  fingerprint256,
  timeoutMs,
  cookieJar,
}) {
  return new Promise((resolve, reject) => {
    const safePath = validateRequestPath(path);
    const secureTransport = target.protocol === "https";
    const transport = secureTransport ? https : http;
    const headers = {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent": "Network-Warden-ReadOnly-Connector/0.5",
    };
    if (cookieJar.size) headers.Cookie = cookieHeader(cookieJar);
    if (body !== null) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(body);
    }

    let settled = false;
    const request = transport.request({
      host: target.host,
      port: target.port,
      path: safePath,
      method,
      headers,
      ...(secureTransport ? { rejectUnauthorized: false } : {}),
      agent: false,
      timeout: timeoutMs,
      ...(secureTransport
        ? { servername: net.isIP(target.host) ? undefined : target.host }
        : {}),
    });

    function fail(error) {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    }

    if (secureTransport) {
      request.once("socket", (socket) => {
        socket.once("secureConnect", () => {
          try {
            const certificate = socket.getPeerCertificate();
            assertPinnedFingerprint(fingerprint256, certificate.fingerprint256 ?? "");
            request.end(body ?? undefined);
          } catch (error) {
            fail(error);
          }
        });
      });
    }

    request.once("timeout", () => fail(new Error(`pfSense did not respond within ${timeoutMs} ms.`)));
    request.once("error", fail);
    request.once("response", (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          fail(new Error("The pfSense response exceeded the telemetry size limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        if (settled) return;
        settled = true;
        mergeCookies(cookieJar, response.headers);
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    if (!secureTransport) request.end(body ?? undefined);
  });
}

export function inspectPfSenseCertificate(target, timeoutMs) {
  if (target.protocol !== "https") {
    return Promise.reject(new Error("pfSense certificate inspection requires HTTPS."));
  }
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      rejectUnauthorized: false,
      servername: net.isIP(target.host) ? undefined : target.host,
      timeout: timeoutMs,
    });

    socket.once("secureConnect", () => {
      const certificate = socket.getPeerCertificate();
      socket.destroy();
      if (!certificate?.fingerprint256) {
        reject(new Error("pfSense did not present a usable TLS certificate."));
        return;
      }
      resolve({
        fingerprint256: certificate.fingerprint256,
        subject: certificate.subject?.CN ?? target.host,
        issuer: certificate.issuer?.CN ?? "Self-signed or local issuer",
        validFrom: certificate.valid_from ?? null,
        validTo: certificate.valid_to ?? null,
      });
    });
    socket.once("timeout", () => socket.destroy(new Error(`pfSense did not respond within ${timeoutMs} ms.`)));
    socket.once("error", reject);
  });
}

export async function authenticatePfSense({
  target,
  username,
  password,
  fingerprint256,
  insecureTransportAcknowledged = false,
  timeoutMs,
}) {
  if (typeof username !== "string" || username.length < 1 || username.length > 64) {
    throw new Error("A valid pfSense username is required.");
  }
  if (typeof password !== "string" || password.length < 1 || password.length > 512) {
    throw new Error("A valid pfSense password is required.");
  }
  if (target.protocol === "https" && typeof fingerprint256 !== "string") {
    throw new Error("Trust the pfSense TLS certificate before signing in.");
  }
  if (target.protocol === "http" && insecureTransportAcknowledged !== true) {
    throw new Error("Acknowledge that HTTP sends the pfSense password without encryption.");
  }

  const cookieJar = new Map();
  const loginPage = await telemetryRequest({
    target,
    path: "/",
    fingerprint256,
    timeoutMs,
    cookieJar,
  });
  const form = new URLSearchParams({
    usernamefld: username,
    passwordfld: password,
    login: "Sign In",
  });
  const csrfToken = extractCsrfToken(loginPage.body);
  if (csrfToken) form.set("__csrf_magic", csrfToken);

  await telemetryRequest({
    target,
    path: "/index.php",
    method: "POST",
    body: form.toString(),
    fingerprint256,
    timeoutMs,
    cookieJar,
  });

  const interfacesPage = await telemetryRequest({
    target,
    path: "/status_interfaces.php",
    fingerprint256,
    timeoutMs,
    cookieJar,
  });
  if (isLoginPage(interfacesPage.body)) {
    throw new Error("pfSense rejected the username or password.");
  }
  if (isAccessDeniedPage(interfacesPage.body) || interfacesPage.statusCode === 403) {
    throw new Error("The pfSense account cannot read Status: Interfaces.");
  }

  return {
    cookieJar,
    fingerprint256,
    connectedAt: new Date().toISOString(),
    initialInterfacesHtml: interfacesPage.body,
  };
}

async function readTelemetryPage(session, target, path, timeoutMs) {
  const response = await telemetryRequest({
    target,
    path,
    fingerprint256: session.fingerprint256,
    timeoutMs,
    cookieJar: session.cookieJar,
  });
  if (isLoginPage(response.body)) throw new Error("The pfSense session expired. Reconnect the read-only account.");
  if (isAccessDeniedPage(response.body) || response.statusCode === 403) return null;
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`pfSense telemetry request failed with HTTP ${response.statusCode}.`);
  }
  return response.body;
}

export async function collectPfSenseTelemetry(session, target, timeoutMs) {
  const interfacesPromise = session.initialInterfacesHtml
    ? Promise.resolve(session.initialInterfacesHtml)
    : readTelemetryPage(session, target, "/status_interfaces.php", timeoutMs);
  session.initialInterfacesHtml = null;

  const [interfacesHtml, gatewaysHtml, cpuHtml] = await Promise.all([
    interfacesPromise,
    readTelemetryPage(session, target, "/status_gateways.php", timeoutMs),
    readTelemetryPage(session, target, "/status_cpuload.php", timeoutMs),
  ]);

  return {
    collectedAt: new Date().toISOString(),
    interfaces: interfacesHtml ? parseInterfacesPage(interfacesHtml) : null,
    gateways: gatewaysHtml ? parseGatewaysPage(gatewaysHtml) : null,
    cpuLoadPercent: cpuHtml ? parseCpuLoadPage(cpuHtml) : null,
  };
}

export const pfsenseClientInternals = {
  assertPinnedFingerprint,
  normalizeFingerprint,
  validateRequestPath,
};
