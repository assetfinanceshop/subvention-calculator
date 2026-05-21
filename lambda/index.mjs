// Subvention Calculator — auth Lambda
//
// POST { password } → 200 { token } | 401 | 500
//
// Env vars:
//   PASSWORD            — the access password (KMS-encrypted at rest by Lambda)
//   JWT_SIGNING_SECRET  — random 32+ byte string used to HMAC-SHA256 sign tokens
//   JWT_TTL_HOURS       — optional, defaults to 24
//   CORS_ORIGIN         — optional, defaults to "*" (set to your CloudFront origin in prod)

import { createHmac, timingSafeEqual } from "node:crypto";

function getPassword() {
  const pw = process.env.PASSWORD;
  if (!pw) throw new Error("PASSWORD env var not set");
  return pw;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Cache-Control": "no-store"
  };
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  };
}

export const handler = async (event) => {
  const method =
    event.requestContext?.http?.method ||
    event.httpMethod ||
    "POST";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }

  if (method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  let body = {};
  try {
    const raw = event.body
      ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body)
      : "";
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const submitted = typeof body.password === "string" ? body.password : "";
  if (!submitted) return json(400, { error: "Password required" });

  let expected;
  try {
    expected = getPassword();
  } catch (e) {
    console.error("password env var error:", e);
    return json(500, { error: "Server misconfigured" });
  }

  if (!constantTimeEqual(submitted, expected)) {
    return json(401, { error: "Incorrect password" });
  }

  const signingSecret = process.env.JWT_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("JWT_SIGNING_SECRET not set");
    return json(500, { error: "Server misconfigured" });
  }

  const ttlHours = Number(process.env.JWT_TTL_HOURS || 24);
  const now = Math.floor(Date.now() / 1000);
  const token = signJwt(
    {
      sub: "subvention-calc",
      iat: now,
      exp: now + Math.round(ttlHours * 3600)
    },
    signingSecret
  );

  return json(200, { token, expiresInSeconds: ttlHours * 3600 });
};
