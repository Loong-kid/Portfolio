// 포트폴리오 웹 — Cloudflare Worker 진입점.
// 화면 파일은 public/ (정적 자산), API 는 /api/*, 시세 갱신은 10분 크론.
import * as C from "./calc.js";
import { checkPassword, makeCookie, clearCookie, readSession } from "./auth.js";
import { portfolios, portfolioById, loadSheet, loadSheetFresh, loadPrices, refreshPrices } from "./store.js";
import { buildPortfolio, buildNav } from "./api_view.js";
import { handleEdit } from "./api_edit.js";

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), { ...init, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(init.headers || {}) } });
const err = (status, message) => json({ error: message }, { status });

async function tooManyFailures(env, ip) {
  const n = Number(await env.KV.get(`fail:${ip}`)) || 0;
  return n >= 10;
}
async function noteFailure(env, ip) {
  const n = Number(await env.KV.get(`fail:${ip}`)) || 0;
  await env.KV.put(`fail:${ip}`, String(n + 1), { expirationTtl: 900 });
}

async function handleApi(req, env, ctx, url) {
  const path = url.pathname;

  if (path === "/api/portfolios" && req.method === "GET") {
    return json(portfolios(env).map((p) => ({ id: p.id, name: p.name })));
  }

  if (path === "/api/login" && req.method === "POST") {
    const ip = req.headers.get("cf-connecting-ip") || "unknown";
    if (await tooManyFailures(env, ip)) return err(429, "로그인 실패가 너무 많아요. 15분 뒤에 다시 시도해 주세요.");
    const body = await req.json().catch(() => ({}));
    const p = portfolioById(env, String(body.pid || ""));
    if (!p) return err(400, "포트폴리오를 골라 주세요.");
    const role = await checkPassword(env, p.id, String(body.password || ""));
    if (!role) { await noteFailure(env, ip); return err(401, "비밀번호가 맞지 않아요."); }
    return json({ ok: true, pid: p.id, role }, { headers: { "set-cookie": await makeCookie(env, p.id, role) } });
  }

  if (path === "/api/logout" && req.method === "POST") {
    return json({ ok: true }, { headers: { "set-cookie": clearCookie() } });
  }

  const session = await readSession(env, req);
  if (!session) return err(401, "로그인이 필요해요.");
  const p = portfolioById(env, session.pid);
  if (!p) return err(401, "로그인이 필요해요.");
  const isAdmin = session.role === "admin";

  if (path === "/api/me") return json({ pid: p.id, name: p.name, role: session.role });

  if (path === "/api/portfolio" && req.method === "GET") {
    const t0 = Date.now();
    const [sheet, px] = await Promise.all([loadSheet(env, ctx, p), loadPrices(env)]);
    const t1 = Date.now();
    const out = buildPortfolio(p, session.role, sheet.tabs, px, C.todayKst());
    return json({ ...out, sheetAt: sheet.at, stale: sheet.stale }, { headers: { "server-timing": `load;dur=${t1 - t0}, calc;dur=${Date.now() - t1}` } });
  }

  if (!isAdmin) return err(403, "관리자만 볼 수 있어요.");

  if (path === "/api/nav" && req.method === "GET") {
    const t0 = Date.now();
    const [sheet, px] = await Promise.all([loadSheet(env, ctx, p), loadPrices(env)]);
    const t1 = Date.now();
    const out = buildNav(sheet.tabs, px, C.todayKst());
    return json({ ...out, sheetAt: sheet.at, stale: sheet.stale }, { headers: { "server-timing": `load;dur=${t1 - t0}, calc;dur=${Date.now() - t1}` } });
  }

  if (path === "/api/refresh" && req.method === "POST") {
    // 시트 새로 읽기 (+ 시세 즉시 갱신)
    const tabs = await loadSheetFresh(env, p);
    const log = await refreshPrices(env, { portfolioTabs: { [p.id]: tabs } });
    return json({ ok: true, log });
  }

  try {
    const out = await handleEdit(req, env, ctx, url, p);
    if (out) return json(out);
  } catch (e) {
    if (e.status === 400) return err(400, e.message);
    throw e;
  }

  return err(404, "없는 API");
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(req, env, ctx, url); }
      catch (e) { return err(500, `서버 오류: ${String(e.message || e).slice(0, 300)}`); }
    }
    return env.ASSETS.fetch(req);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshPrices(env).then((log) => console.log(log.join(" | "))).catch((e) => console.error("크론 실패", e)));
  },
};
