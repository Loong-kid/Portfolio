// 로그인: Streamlit 과 같은 SHA-256 비밀번호 해시 비교 → HMAC 서명 쿠키.
// 포트폴리오별 해시가 있으면 그것(ADMIN_PASSWORD_HASH_HEE 등), 없으면 공통 해시.

const COOKIE = "pf_session";
const MAX_AGE = 30 * 24 * 3600; // 30일

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64u = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/"))));

export async function sha256Hex(s) {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(env.SESSION_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

/** 비밀번호 → 'admin' | 'guest' | null */
export async function checkPassword(env, pid, password) {
  const h = await sha256Hex(password);
  const up = pid.toUpperCase();
  const admin = env[`ADMIN_PASSWORD_HASH_${up}`] || env.ADMIN_PASSWORD_HASH || "";
  const guest = env[`GUEST_PASSWORD_HASH_${up}`] || env.GUEST_PASSWORD_HASH || "";
  if (admin && safeEqual(h, admin.trim().toLowerCase())) return "admin";
  if (guest && safeEqual(h, guest.trim().toLowerCase())) return "guest";
  return null;
}

export async function makeCookie(env, pid, role) {
  const payload = b64u(JSON.stringify({ pid, role, exp: Math.floor(Date.now() / 1000) + MAX_AGE }));
  const sig = await hmac(env, payload);
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`;
}

export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

/** 요청 쿠키 → {pid, role} | null */
export async function readSession(env, req) {
  const raw = (req.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [payload, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig) return null;
  if (!safeEqual(await hmac(env, payload), sig)) return null;
  try {
    const s = JSON.parse(unb64u(payload));
    if (!s.exp || s.exp < Date.now() / 1000) return null;
    return { pid: s.pid, role: s.role };
  } catch { return null; }
}
