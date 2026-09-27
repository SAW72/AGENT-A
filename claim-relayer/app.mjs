import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { healthPayload, httpError } from "./config.mjs";
import { KILL_SWITCH } from "./killSwitch.mjs";
import {
  assertBaseSepolia,
  buildFixtureClaim,
  buildFixtureQuote,
  describeCalldata,
  liveSubmitError,
  submitLiveClaim,
  wantsLiveSubmit,
} from "./claims.mjs";

const MAX_BODY = 32 * 1024;

function secretsEqual(provided, expected) {
  const a = Buffer.from(String(provided || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (!expected || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function bearerToken(req) {
  const auth = String(req.headers.authorization || "");
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export function adminAuthorized(req, adminSecret) {
  if (!adminSecret) return false;
  const header = req.headers["x-admin-secret"] || "";
  return secretsEqual(header, adminSecret) || secretsEqual(bearerToken(req), adminSecret);
}

/** Live claim auth. Separate from ADMIN_SECRET. Accepts x-claim-secret or Bearer. */
export function claimAuthorized(req, claimApiSecret) {
  if (!claimApiSecret) return false;
  const header = req.headers["x-claim-secret"] || "";
  return secretsEqual(header, claimApiSecret) || secretsEqual(bearerToken(req), claimApiSecret);
}

export function createCors(allowedOrigins) {
  const allowed = new Set(
    (Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins || "").split(","))
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );
  return function corsHeaders(req) {
    const headers = {
      "access-control-allow-headers": "content-type,x-admin-secret,authorization,x-claim-secret",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      vary: "Origin",
    };
    const origin = req.headers.origin;
    const normalized = origin ? String(origin).replace(/\/$/, "") : "";
    if (normalized && allowed.has(normalized)) headers["access-control-allow-origin"] = origin;
    return headers;
  };
}

function sendJson(res, req, status, body, corsHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    ...corsHeaders(req),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(httpError(413, "payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(httpError(400, "invalid_json"));
          return;
        }
        resolve(parsed);
      } catch {
        reject(httpError(400, "invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function errorBody(err) {
  const body = {
    ok: false,
    error: err.error || "request_failed",
  };
  for (const key of [
    "reason",
    "field",
    "chainId",
    "mode",
    "txHash",
    "blockers",
    "dryRun",
    "escrowBooked",
    "escrowAddress",
    "action",
    "signature",
    "selector",
    "calldata",
    "valueWei",
    "calldataStatus",
    "senderConstraint",
    "senderNote",
    "fixture",
    "revert_data",
  ]) {
    if (err[key] !== undefined) body[key] = err[key];
  }
  return body;
}

function rejectLive(config, body) {
  const err = liveSubmitError(config);
  Object.assign(err, describeCalldata(body));
  throw err;
}

function rejectQuoteBroadcast(config, body) {
  const err = httpError(409, "live_submit_blocked", {
    reason: "quote_does_not_broadcast",
    blockers: [],
    mode: "fixture",
    txHash: null,
    dryRun: true,
    escrowBooked: config.escrowBooked,
    escrowAddress: config.escrowAddress,
  });
  Object.assign(err, describeCalldata(body));
  throw err;
}

/**
 * HTTP control plane. Quotes stay dry-run. Claims broadcast only when live submit is allowed.
 * @param {object} deps
 * @param {ReturnType<import('./config.mjs').loadConfig>} deps.config
 * @param {{ isOn: Function, engage: Function, release: Function }} deps.killSwitch
 * @param {{ reserve: Function }} deps.nonceStore
 * @param {{ append: Function }} deps.claimLog
 * @param {() => number} [deps.now]
 * @param {{ send: Function } | null} [deps.broadcaster]
 * @param {(args: { method: string, params?: unknown[] }) => Promise<unknown>} [deps.rpc]
 */
export function createClaimRelayer(deps) {
  const config = deps.config;
  const killSwitch = deps.killSwitch;
  const nonceStore = deps.nonceStore;
  const claimLog = deps.claimLog;
  const broadcaster = deps.broadcaster || null;
  const rpc = deps.rpc || null;
  const now = deps.now || Date.now;
  const corsHeaders = createCors(config.corsOrigins);

  function refuseIfKilled(res, req) {
    if (!killSwitch.isOn()) return false;
    sendJson(res, req, 503, { ok: false, error: KILL_SWITCH }, corsHeaders);
    return true;
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req));
        res.end();
        return;
      }
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
        sendJson(res, req, 200, healthPayload(config, killSwitch.isOn()), corsHeaders);
        return;
      }

      if (req.method === "POST" && (path === "/v1/admin/pause" || path === "/v1/admin/unpause")) {
        if (!config.adminSecret) {
          sendJson(
            res,
            req,
            200,
            {
              ok: true,
              noop: true,
              killSwitch: killSwitch.isOn(),
              docs: "ADMIN_SECRET is unset. Pause and unpause do not change the kill switch. Set ADMIN_SECRET to gate those routes. KILL_SWITCH=1 still starts the process paused.",
            },
            corsHeaders,
          );
          return;
        }
        if (!adminAuthorized(req, config.adminSecret)) {
          sendJson(res, req, 401, { ok: false, error: "unauthorized" }, corsHeaders);
          return;
        }
        if (path.endsWith("/pause")) killSwitch.engage();
        else killSwitch.release();
        await claimLog.append({
          event: path.endsWith("/pause") ? "kill_switch_on" : "kill_switch_off",
          killSwitch: killSwitch.isOn(),
          chainId: config.chainId,
        });
        sendJson(res, req, 200, { ok: true, killSwitch: killSwitch.isOn(), noop: false }, corsHeaders);
        return;
      }

      if (req.method === "POST" && path === "/v1/claims/quote") {
        if (refuseIfKilled(res, req)) return;
        const body = await readBody(req);
        assertBaseSepolia(body);
        if (wantsLiveSubmit(body)) {
          if (!config.liveSubmit.allowed) rejectLive(config, body);
          rejectQuoteBroadcast(config, body);
        }
        const quote = await buildFixtureQuote({ body, config, nonceStore, now });
        await claimLog.append({ event: "quote", ...quote, ok: true });
        sendJson(res, req, 200, quote, corsHeaders);
        return;
      }

      if (req.method === "POST" && path === "/v1/claims") {
        if (refuseIfKilled(res, req)) return;
        const body = await readBody(req);
        assertBaseSepolia(body);
        if (wantsLiveSubmit(body)) {
          if (!config.liveSubmit.allowed) rejectLive(config, body);
          if (!config.claimApiSecret) {
            throw httpError(503, "claim_api_secret_required");
          }
          if (!claimAuthorized(req, config.claimApiSecret)) {
            sendJson(res, req, 401, { ok: false, error: "unauthorized" }, corsHeaders);
            return;
          }
          const result = await submitLiveClaim({ body, config, broadcaster, rpc });
          await claimLog.append({
            event: "claim_live",
            ...result,
            payer: body.payer,
            payee: body.payee,
            amountWei: body.amountWei,
            chainId: config.chainId,
            escrowBooked: config.escrowBooked,
            relayerAddress: config.relayerAddress,
          });
          sendJson(res, req, 200, result, corsHeaders);
          return;
        }
        const result = buildFixtureClaim(body, config);
        await claimLog.append({
          event: "claim_fixture",
          ...result,
          payer: body.payer,
          payee: body.payee,
          amountWei: body.amountWei,
          chainId: config.chainId,
          escrowBooked: config.escrowBooked,
          relayerAddress: config.relayerAddress,
        });
        sendJson(res, req, 200, result, corsHeaders);
        return;
      }

      sendJson(res, req, 404, { ok: false, error: "not_found" }, corsHeaders);
    } catch (err) {
      const status = Number(err.status) || 500;
      const body = errorBody(status === 500 ? { error: "request_failed" } : err);
      if (status === 500 || status === 502) {
        console.error("claim_relayer_error", err.error || "request_failed");
      }
      try {
        await claimLog.append({
          event: "claim_error",
          error: body.error,
          reason: body.reason,
          status,
          chainId: config.chainId,
        });
      } catch {
        /* logging must not hide the response */
      }
      if (!res.headersSent) sendJson(res, req, status, body, corsHeaders);
    }
  });
}
