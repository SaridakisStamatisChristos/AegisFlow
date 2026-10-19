import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as oidc from "openid-client";
import { AegisFlowClient } from "@aegisflow/sdk";
import type { OperatorConsoleClient } from "./index.js";

interface Login { readonly verifier: string; readonly nonce: string; readonly expires: number }
interface Session { readonly subject: string; readonly idToken: string; readonly expires: number; readonly csrf: string }
export interface OidcConsoleOptions {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly baseUrl: string;
  readonly apiToken: string;
}

function rand(): string { return randomBytes(32).toString("base64url"); }
function response(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(message);
}
function redirect(response: ServerResponse, target: string, cookie?: string | readonly string[]): void {
  const headers: Record<string, string | string[]> = { location: target, "cache-control": "no-store" };
  if (cookie) headers["set-cookie"] = typeof cookie === "string" ? cookie : [...cookie];
  response.writeHead(303, headers); response.end();
}
function parseCookies(request: IncomingMessage): Map<string, string> {
  const parsed = new Map<string, string>();
  const value = request.headers.cookie;
  if (typeof value !== "string" || value.length > 4096) return parsed;
  for (const part of value.split(";")) {
    const match = /^\s*([a-z_]+)=([A-Za-z0-9_-]+)\s*$/u.exec(part);
    if (!match || parsed.has(match[1]!)) return new Map();
    parsed.set(match[1]!, match[2]!);
  }
  return parsed;
}
function noStoreCookie(name: string, secure: boolean): string {
  return name + "=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0" + (secure ? "; Secure" : "");
}
function setCookie(name: string, value: string, lifetime: number, secure: boolean): string {
  return name + "=" + value + "; HttpOnly; Path=/; SameSite=Lax; Max-Age=" +
    lifetime + (secure ? "; Secure" : "");
}
async function readLogoutBody(request: IncomingMessage): Promise<string | undefined> {
  if (request.headers["content-type"] !== "application/x-www-form-urlencoded") return undefined;
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 4096) return undefined;
  }
  const form = new URLSearchParams(body);
  return form.get("csrf") ?? undefined;
}

/**
 * Server-side OpenID Connect relying party. The browser receives only opaque
 * session/transaction cookies; never the service credential or ID token.
 * API authorization is separately performed using that ID token + service key.
 */
export async function createOidcConsoleAuthorization(options: OidcConsoleOptions): Promise<
  (request: IncomingMessage, response: ServerResponse) =>
    Promise<{ readonly client: OperatorConsoleClient; readonly csrfToken: string } | undefined>
> {
  const issuer = new URL(options.issuer);
  const callback = new URL(options.redirectUri);
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.hash) {
    throw new Error("OIDC issuer must be an HTTPS URL.");
  }
  if (callback.pathname !== "/auth/callback" || callback.search || callback.hash ||
      callback.username || callback.password ||
      (callback.protocol !== "https:" && !(callback.protocol === "http:" &&
        ["127.0.0.1", "[::1]"].includes(callback.hostname)))) {
    throw new Error("OIDC redirect URI must be the exact HTTPS or literal loopback callback.");
  }
  if (!options.clientId || !options.clientSecret || !options.apiToken) {
    throw new Error("OIDC client ID, confidential client secret and API credential are required.");
  }
  const client = await oidc.discovery(issuer, options.clientId, options.clientSecret);
  const transactions = new Map<string, Login>();
  const sessions = new Map<string, Session>();
  const secure = callback.protocol === "https:";
  const now = () => Date.now();
  const prune = () => {
    for (const [k, v] of transactions) if (v.expires <= now()) transactions.delete(k);
    for (const [k, v] of sessions) if (v.expires <= now()) sessions.delete(k);
  };
  return async (request, res) => {
    prune();
    const method = request.method ?? "";
    // All successful callbacks must enter under the exactly registered origin.
    const authority = request.headers.host;
    if (typeof authority !== "string" || "http://" + authority !== callback.origin &&
        "https://" + authority !== callback.origin) {
      response(res, 400, "Invalid callback authority."); return undefined;
    }
    const url = new URL(request.url ?? "/", callback);
    const path = url.pathname;
    const cookies = parseCookies(request);
    const sessionId = cookies.get("af_session");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (method === "GET" && path === "/auth/login") {
      if (transactions.size >= 128) { response(res, 429, "Too many pending logins."); return undefined; }
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      transactions.set(state, { verifier, nonce, expires: now() + 300_000 });
      const authUrl = oidc.buildAuthorizationUrl(client, {
        redirect_uri: options.redirectUri, scope: "openid",
        response_type: "code", code_challenge: challenge, code_challenge_method: "S256",
        state, nonce,
      });
      redirect(res, authUrl.href, setCookie("af_oidc", state, 300, secure));
      return undefined;
    }
    if (method === "GET" && path === "/auth/callback") {
      const state = url.searchParams.get("state");
      const cookieState = cookies.get("af_oidc");
      const pending = state && state === cookieState ? transactions.get(state) : undefined;
      if (!state || !pending || pending.expires <= now()) {
        response(res, 401, "Invalid, expired or replayed login state."); return undefined;
      }
      transactions.delete(state); // Atomic single-use OAuth callback.
      if (sessionId) sessions.delete(sessionId);
      try {
        const tokens = await oidc.authorizationCodeGrant(client, url, {
          pkceCodeVerifier: pending.verifier,
          expectedState: state,
          expectedNonce: pending.nonce,
          idTokenExpected: true,
        });
        const claims = tokens.claims();
        if (!tokens.id_token || !claims?.sub || typeof claims.exp !== "number") throw new Error("No verified ID token.");
        const remaining = Math.min(1800, Math.floor(claims.exp - now() / 1000));
        if (remaining <= 0) throw new Error("Expired identity token.");
        const sid = rand();
        sessions.set(sid, {
          subject: claims.sub, idToken: tokens.id_token, expires: now() + remaining * 1000, csrf: rand(),
        });
        redirect(res, "/", [
          noStoreCookie("af_oidc", secure),
          setCookie("af_session", sid, remaining, secure),
        ]);
      } catch {
        redirect(res, "/auth/login?failure=1", noStoreCookie("af_oidc", secure));
      }
      return undefined;
    }
    if (path === "/auth/logout" && method === "POST") {
      const csrf = await readLogoutBody(request);
      if (!session || csrf === undefined || csrf !== session.csrf) {
        response(res, 403, "Sign out requires an authenticated session and CSRF token."); return undefined;
      }
      sessions.delete(sessionId!);
      redirect(res, "/auth/login", noStoreCookie("af_session", secure));
      return undefined;
    }
    if (!session) {
      response(res, 401, "Login required. Visit /auth/login."); return undefined;
    }
    if (path === "/auth/logout" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      res.end('<form method="post" action="/auth/logout"><input type="hidden" name="csrf" value="' +
        session.csrf + '"><button type="submit">Sign out</button></form>');
      return undefined;
    }
    return {
      client: new AegisFlowClient({
        baseUrl: options.baseUrl, apiToken: options.apiToken, humanIdToken: session.idToken,
      }),
      csrfToken: session.csrf,
    };
  };
}
