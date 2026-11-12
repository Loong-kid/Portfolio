// 시트·시세 캐시 (KV) + 10분 크론 시세 갱신.
//  sheet:<pid>  {at, tabs}            — 시트 탭 원본 (60초 지나면 뒤에서 새로 받음)
//  px:current   {at, prices:{심볼:{p,d,src}}, fx:{USD:{p,d,src}...}}
//  px:hist      {at, s:{심볼:{upd, from, s:[[d,c]...]}}, fx:{USD:{upd, from, s}}}
//  px:codes     {심볼: 네이버해외코드|""}
import { readTabs } from "./google.js";
import * as C from "./calc.js";
import * as X from "./prices.js";
import { refreshFundamentals } from "./fundamentals.js";

export const VIEW_TABS = ["snapshots", "flows", "debt_history", "nav_anchors", "stock_notes", "watchlist", "categories", "ticker_map", "portfolio_order"];
const SHEET_FRESH_MS = 60 * 1000;
const HIST_REFRESH_MS = 6 * 3600 * 1000;

export function portfolios(env) {
  return JSON.parse(env.PORTFOLIOS);
}
export function portfolioById(env, pid) {
  return portfolios(env).find((p) => p.id === pid) || null;
}

// 같은 isolate 안에서 15초 메모 (KV 읽기 + JSON 파싱 생략)
const memo = new Map();
const MEMO_MS = 15 * 1000;
async function kvGet(env, key) {
  const m = memo.get(key);
  if (m && Date.now() - m.t < MEMO_MS) return m.v;
  const v = await env.KV.get(key, "json");
  memo.set(key, { t: Date.now(), v });
  return v;
}
async function kvPut(env, key, val) {
  memo.set(key, { t: Date.now(), v: val });
  await env.KV.put(key, JSON.stringify(val));
}

/** 시트를 직접 읽어 캐시에 넣는다. */
export async function loadSheetFresh(env, p, tabs = VIEW_TABS) {
  const data = await readTabs(env, p.sheet, tabs);
  if (tabs === VIEW_TABS) await kvPut(env, `sheet:${p.id}`, { at: Date.now(), tabs: data });
  return data;
}

/** 보기용: 캐시가 60초 넘었으면 일단 캐시를 주고 뒤에서 새로 받는다. */
export async function loadSheet(env, ctx, p) {
  const cached = await kvGet(env, `sheet:${p.id}`);
  if (cached) {
    const age = Date.now() - cached.at;
    if (age > SHEET_FRESH_MS && ctx) ctx.waitUntil(loadSheetFresh(env, p).catch(() => {}));
    return { tabs: cached.tabs, at: cached.at, stale: age > SHEET_FRESH_MS };
  }
  const tabs = await loadSheetFresh(env, p);
  return { tabs, at: Date.now(), stale: false };
}

export async function invalidateSheet(env, pid) {
  memo.delete(`sheet:${pid}`);
  await env.KV.delete(`sheet:${pid}`);
}

export async function loadPrices(env) {
  const [current, hist] = await Promise.all([kvGet(env, "px:current"), kvGet(env, "px:hist")]);
  return { current: current || { at: 0, prices: {}, fx: {} }, hist: hist || { at: 0, s: {}, fx: {} } };
}

// ---------- 종목 → 심볼 ----------
const tradable = (t) => t && !C.isCashLike(t) && !String(t).includes("→");

/** 한 포트폴리오에서 현재가가 필요한 심볼 / 이력이 필요한 심볼 */
export function symbolsFor(tabs, today) {
  const tmap = C.loadMap(tabs.ticker_map, "종목", "yfinance_symbol");
  const snaps = C.loadSnapshots(tabs.snapshots);
  const latest = C.snapshotAtOrBefore(snaps, today);
  const cur = new Set(), hist = new Set();
  for (const r of latest ? latest.rows : []) if (tradable(r.종목) && tmap[r.종목]) cur.add(tmap[r.종목]);
  for (const w of tabs.watchlist) { const t = String(w["종목"] ?? "").trim(); if (tmap[t]) cur.add(tmap[t]); }
  for (const r of snaps) if (tradable(r.종목) && tmap[r.종목]) hist.add(tmap[r.종목]);
  const first = snaps.length ? snaps[0].날짜 : today;
  return { cur, hist, first };
}

function minusDays(d, n) {
  const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() - n); return t.toISOString().slice(0, 10);
}

/**
 * 크론: 시세·환율·이력 갱신. 무료 플랜 바깥 호출 50개 안에서 끝낸다.
 * opts.portfolioTabs 를 주면 시트를 다시 안 읽는다.
 */
export async function refreshPrices(env, opts = {}) {
  const budget = new X.Budget(46);
  const today = C.todayKst();
  const log = [];

  // 1) 두 포트폴리오의 심볼 모으기 (시트 캐시가 10분 안이면 그대로 사용)
  const cur = new Set(), hist = new Set();
  let first = today;
  for (const p of portfolios(env)) {
    let tabs = opts.portfolioTabs?.[p.id];
    if (!tabs) {
      const cached = await kvGet(env, `sheet:${p.id}`);
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) tabs = cached.tabs;
      else { budget.take(); budget.take(); budget.take(); tabs = await loadSheetFresh(env, p); }
    }
    const s = symbolsFor(tabs, today);
    s.cur.forEach((x) => cur.add(x)); s.hist.forEach((x) => hist.add(x));
    if (s.first < first) first = s.first;
  }
  const from = minusDays(first, 14);

  // 2) 네이버 해외 코드 (처음 한 번만, 한 번에 최대 8개)
  const codes = (await kvGet(env, "px:codes")) || {};
  let codesChanged = false, resolved = 0;
  for (const s of new Set([...cur, ...hist])) {
    if (X.classify(s).kind === "world" && !(s in codes) && resolved < 8 && budget.left > 20) {
      codes[s] = await X.resolveNaverCode(s, budget).catch(() => "");
      codesChanged = true; resolved++;
    }
  }
  if (codesChanged) await kvPut(env, "px:codes", codes);

  // 3) 현재가 + 환율
  const [prices, fx] = await Promise.all([X.fetchCurrent([...cur], codes, budget), X.fetchFx(budget)]);
  const old = (await kvGet(env, "px:current")) || { prices: {}, fx: {} };
  // 이번에 실패한 건 이전 값 유지 (출처 표시는 그대로)
  const current = { at: Date.now(), prices: { ...old.prices, ...prices }, fx: { ...old.fx, ...fx }, failed: [...cur].filter((s) => !prices[s]) };
  await kvPut(env, "px:current", current);
  log.push(`현재가 ${Object.keys(prices).length}/${cur.size}, 환율 ${Object.keys(fx).length}/3`);

  // 4) 이력: 없는 것 먼저, 그다음 6시간 지난 것. 남은 호출 한도만큼.
  const H = (await kvGet(env, "px:hist")) || { s: {}, fx: {} };
  const jobs = [];
  for (const s of hist) {
    const e = H.s[s];
    if (!e || e.from > from) jobs.push({ kind: "s", key: s, pri: 0 });
    else if (Date.now() - e.upd > HIST_REFRESH_MS) jobs.push({ kind: "s", key: s, pri: 1 });
  }
  for (const c of ["USD", "EUR", "JPY"]) {
    const e = H.fx[c];
    if (!e || e.from > from) jobs.push({ kind: "fx", key: c, pri: 0 });
    else if (Date.now() - e.upd > HIST_REFRESH_MS) jobs.push({ kind: "fx", key: c, pri: 1 });
  }
  jobs.sort((a, b) => a.pri - b.pri);
  let done = 0;
  for (const j of jobs) {
    if (budget.left < 2) break;
    try {
      const series = j.kind === "s" ? await X.fetchHistory(j.key, from, today, budget) : await X.yahooHistory(X.fxSymbol(j.key), from, today, budget);
      const entry = { upd: Date.now(), from, s: series };
      if (j.kind === "s") H.s[j.key] = entry; else H.fx[j.key] = entry;
      done++;
    } catch (e) { log.push(`이력 실패 ${j.key}: ${String(e).slice(0, 80)}`); }
  }
  if (done) { H.at = Date.now(); await kvPut(env, "px:hist", H); }
  log.push(`이력 ${done}/${jobs.length} 갱신, 남은 호출 ${budget.left}`);

  // 5) 재무 (종목 분석 카드): 20시간 지난 종목을 오래된 순으로 몇 개씩
  if (budget.left >= 8) {
    try { log.push(await refreshFundamentals(env, [...cur], budget, 3)); }
    catch (e) { log.push(`재무 실패: ${String(e).slice(0, 80)}`); }
  }
  return log;
}
