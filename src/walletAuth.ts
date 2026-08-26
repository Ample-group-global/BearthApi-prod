import crypto from "crypto";
export const COOKIE_NAME = "admin_session";
export const COOKIE_MAX_AGE = 86400;
const TTL_MS = 24 * 60 * 60 * 1000;
function sign(data: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

export function createSessionToken(address: string): string {
  const payload = JSON.stringify({ address, exp: Date.now() + TTL_MS });
  const data = Buffer.from(payload).toString("base64url");
  return `${data}.${sign(data)}`;
}

export function verifySessionCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^\\s;]+)`));
  if (!match) return null;
  const token = match[1];
  const dot = token.lastIndexOf(".");
  if (dot === -1) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  try {
    const expected = sign(data);
    const sigBuf = Buffer.from(sig, "base64url");
    const expBuf = Buffer.from(expected, "base64url");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  } catch { return null; }
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString()) as { address: string; exp: number };
    if (Date.now() > payload.exp) return null;
    return payload.address;
  } catch { return null; }
}
