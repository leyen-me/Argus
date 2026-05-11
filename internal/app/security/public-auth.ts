import crypto from "node:crypto";
import net from "node:net";
import type http from "node:http";
import type { NextFunction, Request, Response } from "express";

const TOKEN_VERSION = "v1";
const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

type TokenPayload = {
  v: typeof TOKEN_VERSION;
  iat: number;
  exp: number;
  nonce: string;
};

export type AuthSessionDto = {
  authRequired: boolean;
  authenticated: boolean;
};

function publicPassword(): string {
  return String(process.env.ARGUS_PUBLIC_PASSWORD || "").trim();
}

function tokenTtlSeconds(): number {
  const raw = Number(process.env.ARGUS_PUBLIC_AUTH_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TOKEN_TTL_SECONDS;
  return Math.floor(raw);
}

function trustProxy(): boolean {
  const raw = String(process.env.ARGUS_TRUST_PROXY || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a).digest();
  const bh = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signPayload(payloadPart: string, password: string): string {
  return crypto.createHmac("sha256", password).update(payloadPart).digest("base64url");
}

function normalizeIp(raw: string | undefined | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("::ffff:")) return trimmed.slice("::ffff:".length);
  return trimmed;
}

function firstForwardedIp(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return normalizeIp(raw[0]);
  if (!raw) return "";
  return normalizeIp(raw.split(",")[0]);
}

function ipToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out = (out << 8) + n;
  }
  return out >>> 0;
}

function isIpv4InRange(ip: string, base: string, maskBits: number): boolean {
  const value = ipToNumber(ip);
  const baseValue = ipToNumber(base);
  if (value == null || baseValue == null) return false;
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

export function isPrivateNetworkIp(rawIp: string | undefined | null): boolean {
  const ip = normalizeIp(rawIp);
  if (!ip) return true;
  if (ip === "localhost" || ip === "127.0.0.1" || ip === "::1") return true;
  if (net.isIPv4(ip)) {
    return (
      isIpv4InRange(ip, "10.0.0.0", 8) ||
      isIpv4InRange(ip, "172.16.0.0", 12) ||
      isIpv4InRange(ip, "192.168.0.0", 16) ||
      isIpv4InRange(ip, "127.0.0.0", 8) ||
      isIpv4InRange(ip, "169.254.0.0", 16)
    );
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  return false;
}

export function getRequestClientIp(req: Request): string {
  if (trustProxy()) {
    return normalizeIp(req.ip || firstForwardedIp(req.headers["x-forwarded-for"]));
  }
  return normalizeIp(req.socket.remoteAddress);
}

export function getIncomingMessageClientIp(req: http.IncomingMessage): string {
  if (trustProxy()) {
    return firstForwardedIp(req.headers["x-forwarded-for"]) || normalizeIp(req.socket.remoteAddress);
  }
  return normalizeIp(req.socket.remoteAddress);
}

export function isRequestFromPrivateNetwork(req: Request): boolean {
  return isPrivateNetworkIp(getRequestClientIp(req));
}

export function isIncomingMessageFromPrivateNetwork(req: http.IncomingMessage): boolean {
  return isPrivateNetworkIp(getIncomingMessageClientIp(req));
}

export function isPublicPasswordConfigured(): boolean {
  return publicPassword().length > 0;
}

export function isPublicAuthRequiredForRequest(req: Request): boolean {
  return isPublicPasswordConfigured() && !isRequestFromPrivateNetwork(req);
}

export function isPublicAuthRequiredForIncomingMessage(req: http.IncomingMessage): boolean {
  return isPublicPasswordConfigured() && !isIncomingMessageFromPrivateNetwork(req);
}

export function issuePublicAuthToken(): string {
  const password = publicPassword();
  if (!password) return "";
  const now = Math.floor(Date.now() / 1000);
  const payload: TokenPayload = {
    v: TOKEN_VERSION,
    iat: now,
    exp: now + tokenTtlSeconds(),
    nonce: crypto.randomUUID(),
  };
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  return `${payloadPart}.${signPayload(payloadPart, password)}`;
}

export function verifyPublicAuthToken(token: unknown): boolean {
  const password = publicPassword();
  if (!password || typeof token !== "string" || !token.trim()) return false;
  const [payloadPart, signature, extra] = token.trim().split(".");
  if (!payloadPart || !signature || extra != null) return false;
  const expected = signPayload(payloadPart, password);
  if (!timingSafeStringEqual(signature, expected)) return false;
  try {
    const payload = JSON.parse(base64UrlDecode(payloadPart)) as Partial<TokenPayload>;
    const now = Math.floor(Date.now() / 1000);
    return payload.v === TOKEN_VERSION && typeof payload.exp === "number" && payload.exp > now;
  } catch {
    return false;
  }
}

export function verifyPublicPassword(candidate: unknown): boolean {
  const password = publicPassword();
  return !!password && typeof candidate === "string" && timingSafeStringEqual(candidate, password);
}

export function extractBearerToken(req: Request): string {
  const header = String(req.headers.authorization || "").trim();
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return header.slice("bearer ".length).trim();
}

export function extractWebSocketToken(req: http.IncomingMessage): string {
  try {
    const url = new URL(req.url || "", "http://argus.local");
    const queryToken = url.searchParams.get("argus_token");
    if (queryToken) return queryToken.trim();
  } catch {
    /* ignore malformed URL */
  }
  const header = String(req.headers.authorization || "").trim();
  if (header.toLowerCase().startsWith("bearer ")) return header.slice("bearer ".length).trim();
  return "";
}

export function isRequestAuthenticated(req: Request): boolean {
  if (!isPublicAuthRequiredForRequest(req)) return true;
  return verifyPublicAuthToken(extractBearerToken(req));
}

export function isIncomingMessageAuthenticated(req: http.IncomingMessage): boolean {
  if (!isPublicAuthRequiredForIncomingMessage(req)) return true;
  return verifyPublicAuthToken(extractWebSocketToken(req));
}

function unauthorized(res: Response) {
  res.status(401).json({
    ok: false,
    error: "请输入访问密码",
    code: "UNAUTHORIZED",
  });
}

export function publicAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  if (isRequestAuthenticated(req)) {
    next();
    return;
  }
  unauthorized(res);
}

export function publicAuthSession(req: Request): AuthSessionDto {
  const authRequired = isPublicAuthRequiredForRequest(req);
  return {
    authRequired,
    authenticated: !authRequired || verifyPublicAuthToken(extractBearerToken(req)),
  };
}

export function configureTrustProxy(app: { set(name: string, value: boolean): unknown }) {
  if (trustProxy()) app.set("trust proxy", true);
}
