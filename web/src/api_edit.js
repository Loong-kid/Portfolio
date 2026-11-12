// 편집 API (관리자 전용). Streamlit app.py 의 저장 동작을 그대로 옮김.
// 원칙: 쓰기 전에는 캐시 말고 시트를 새로 읽는다 (시트 직접 편집분을 덮어쓰지 않게).
import * as C from "./calc.js";
import * as X from "./prices.js";
import { readTabs, writeTab, appendRow } from "./google.js";
import { loadSheetFresh, loadPrices } from "./store.js";
import { currentFx, namePrices } from "./api_view.js";

const CCYS = ["KRW", "USD", "EUR", "JPY"];
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const s = (v) => String(v ?? "").trim();
const numOrNaN = (v) => (typeof v === "number" ? v : C.toNum(String(v ?? "").replace(/,/g, "")));
const cell = (v) => (C.notNaN(v) ? v : ""); // NaN → 빈 칸

async function fresh(env, p, tabs) {
  return readTabs(env, p.sheet, tabs);
}
/** 쓰기 후 보기용 캐시 갱신 */
async function after(env, p) {
  await loadSheetFresh(env, p);
}

// ---------- 스냅샷 ----------
function enrich(rows, prices, fx) {
  // app.py _enrich_with_current_prices: 빈 현재가/환율만 채우고, 둘 다 있으면 평가액 다시 계산
  return rows.map((r) => {
    const o = { ...r };
    const ccy = o.통화 || "KRW";
    const rate = ccy === "KRW" ? 1.0 : (fx[ccy] ?? 0.0);
    const qty = C.notNaN(o.수량) ? o.수량 : 0.0;
    const cur = C.isCashLike(o.종목) ? 1.0 : (prices[o.종목] || 0.0);
    if (!C.notNaN(o.현재가) || o.현재가 === 0) o.현재가 = cur > 0 ? cur : NaN;
    if (!C.notNaN(o.환율) || o.환율 === 0) o.환율 = rate;
    if (C.notNaN(o.현재가) && C.notNaN(o.환율)) o.평가액 = qty * o.현재가 * o.환율;
    return o;
  });
}

function cleanRows(rows) {
  return (rows || []).map((r) => ({
    종목: s(r.종목), 통화: s(r.통화) || "KRW",
    수량: numOrNaN(r.수량), 평균단가: numOrNaN(r.평균단가),
    현재가: numOrNaN(r.현재가), 환율: numOrNaN(r.환율), 평가액: numOrNaN(r.평가액),
  }));
}
const outRow = (r) => ({ 종목: r.종목, 통화: r.통화, 수량: C.notNaN(r.수량) ? r.수량 : null, 평균단가: C.notNaN(r.평균단가) ? r.평균단가 : null, 현재가: C.notNaN(r.현재가) ? r.현재가 : null, 환율: C.notNaN(r.환율) ? r.환율 : null, 평가액: C.notNaN(r.평가액) ? r.평가액 : null });

/** portfolio.save_snapshot */
async function saveSnapshot(env, p, date, rowsIn) {
  const tabs = await fresh(env, p, ["snapshots"]);
  const existing = C.loadSnapshots(tabs.snapshots).filter((r) => r.날짜 !== date);
  let rows = cleanRows(rowsIn).filter((r) => r.종목 !== "");
  rows = rows.map((r) => ({ ...r, 수량: C.notNaN(r.수량) ? r.수량 : 0, 평균단가: C.notNaN(r.평균단가) ? r.평균단가 : 0 }));
  rows = rows.filter((r) => Math.abs(r.수량) > 1e-9);
  const m = new Map();
  for (const r of rows) { m.delete(r.종목); m.set(r.종목, r); } // 같은 종목은 마지막 행
  rows = [...m.values()].map((r) => ({ ...r, 날짜: date }));
  if (!rows.length) throw bad("저장할 행이 없어요 (종목명 + 0이 아닌 수량이 1개 이상 필요).");
  const all = [...existing, ...rows].sort((a, b) => (a.날짜 < b.날짜 ? -1 : a.날짜 > b.날짜 ? 1 : a.종목 < b.종목 ? -1 : a.종목 > b.종목 ? 1 : 0));
  await writeTab(env, p.sheet, "snapshots", C.SCHEMAS.snapshots, all.map((r) => ({
    날짜: r.날짜, 종목: r.종목, 통화: r.통화, 수량: cell(r.수량), 평균단가: cell(r.평균단가), 현재가: cell(r.현재가), 환율: cell(r.환율), 평가액: cell(r.평가액),
  })));
  await after(env, p);
  return { date, rows: rows.length, total: C.nansum(rows.map((r) => r.평가액)) };
}

/** 지금 시세를 바로 받아 이름→가격, 환율 (실패분은 10분 캐시로) */
async function livePrices(env, tabs, names) {
  const tmap = C.loadMap(tabs.ticker_map, "종목", "yfinance_symbol");
  const px = await loadPrices(env);
  const codes = (await env.KV.get("px:codes", "json")) || {};
  const syms = [...new Set(names.filter((n) => tmap[n] && !C.isCashLike(n)).map((n) => tmap[n]))];
  const budget = new X.Budget(40);
  const [cur, fx] = await Promise.all([X.fetchCurrent(syms, codes, budget).catch(() => ({})), X.fetchFx(budget).catch(() => ({}))]);
  const prices = {};
  for (const n of names) {
    const sym = tmap[n];
    const v = cur[sym] || px.current.prices[sym];
    if (v && v.p > 0) prices[n] = v.p;
  }
  const rates = { KRW: 1.0 };
  for (const c of ["USD", "EUR", "JPY"]) rates[c] = fx[c]?.p ?? px.current.fx[c]?.p ?? C.DEFAULT_FX[c];
  // 받은 김에 캐시도 갱신
  if (Object.keys(cur).length || Object.keys(fx).length) {
    await env.KV.put("px:current", JSON.stringify({ ...px.current, at: Date.now(), prices: { ...px.current.prices, ...cur }, fx: { ...px.current.fx, ...fx } }));
  }
  return { prices, rates };
}

export async function handleEdit(req, env, ctx, url, p) {
  const path = url.pathname;
  const m = req.method;
  const body = m === "GET" || m === "DELETE" ? {} : await req.json().catch(() => ({}));
  const today = C.todayKst();

  // 스냅샷 목록 + 특정 날짜 행
  if (path === "/api/snapshots" && m === "GET") {
    const sheet = { tabs: await loadSheetFresh(env, p) }; // 편집 화면은 캐시 말고 시트 원본 (직접 편집분 덮어쓰기 방지)
    const snaps = C.loadSnapshots(sheet.tabs.snapshots);
    const counts = new Map();
    for (const r of snaps) counts.set(r.날짜, (counts.get(r.날짜) ?? 0) + 1);
    const dates = [...counts.entries()].map(([날짜, 행수]) => ({ 날짜, 행수 })).sort((a, b) => (a.날짜 < b.날짜 ? 1 : -1));
    const date = C.toDate(url.searchParams.get("date")) || today;
    const mode = url.searchParams.get("mode") === "edit" ? "edit" : "new";
    let rows = C.snapshotOn(snaps, date);
    let carryFrom = null;
    if (!rows.length && mode === "new") {
      const last = C.snapshotAtOrBefore(snaps, today);
      if (last) { rows = last.rows; carryFrom = last.date; }
    }
    rows = rows.map((r) => ({ ...r }));
    if (!rows.length) rows = [{ 종목: "KRW현금", 통화: "KRW", 수량: 0, 평균단가: 1, 현재가: 1, 환율: 1, 평가액: 0 }];
    const isToday = date === today;
    if (carryFrom && isToday) rows = rows.map((r) => ({ ...r, 현재가: NaN, 환율: NaN, 평가액: NaN }));
    if (isToday) {
      const px = await loadPrices(env);
      rows = enrich(rows, namePrices(sheet.tabs, px).prices, currentFx(px));
    }
    return { dates, date, mode, isToday, carryFrom, exists: counts.has(date), rows: rows.map(outRow) };
  }

  if (path === "/api/snapshots" && m === "PUT") {
    const date = C.toDate(body.date);
    if (!date) throw bad("날짜 형식이 올바르지 않아요 (YYYY-MM-DD).");
    // 저장 버튼: 평가액이 비었고 현재가·환율·수량이 있으면 계산
    const rows = cleanRows(body.rows).map((r) => (!C.notNaN(r.평가액) && C.notNaN(r.현재가) && C.notNaN(r.환율) && C.notNaN(r.수량) ? { ...r, 평가액: r.수량 * r.현재가 * r.환율 } : r));
    return { ok: true, ...(await saveSnapshot(env, p, date, rows)) };
  }

  if (path === "/api/snapshots/refresh" && m === "POST") {
    const date = C.toDate(body.date);
    if (!date) throw bad("날짜 형식이 올바르지 않아요.");
    const tabs = await fresh(env, p, ["ticker_map"]);
    const rows0 = cleanRows(body.rows).filter((r) => r.종목);
    const { prices, rates } = await livePrices(env, tabs, rows0.map((r) => r.종목));
    const rows = enrich(rows0.map((r) => ({ ...r, 현재가: NaN, 환율: NaN, 평가액: NaN })), prices, rates);
    const missing = rows.filter((r) => !C.notNaN(r.현재가)).map((r) => r.종목);
    return { ok: true, missing, ...(await saveSnapshot(env, p, date, rows)) };
  }

  if (path === "/api/snapshots" && m === "DELETE") {
    const date = C.toDate(url.searchParams.get("date"));
    if (!date) throw bad("날짜가 필요해요.");
    const tabs = await fresh(env, p, ["snapshots"]);
    const all = C.loadSnapshots(tabs.snapshots);
    const keep = all.filter((r) => r.날짜 !== date);
    const removed = all.length - keep.length;
    if (!removed) return { ok: true, removed: 0 };
    await writeTab(env, p.sheet, "snapshots", C.SCHEMAS.snapshots, keep.map((r) => ({ ...r, 수량: cell(r.수량), 평균단가: cell(r.평균단가), 현재가: cell(r.현재가), 환율: cell(r.환율), 평가액: cell(r.평가액) })));
    await after(env, p);
    return { ok: true, removed, date };
  }

  // ---------- 외부 자금 흐름 ----------
  if (path === "/api/flows" && m === "GET") {
    const sheet = { tabs: await loadSheetFresh(env, p) }; // 편집 화면은 캐시 말고 시트 원본 (직접 편집분 덮어쓰기 방지)
    const flows = C.loadFlows(sheet.tabs.flows);
    const debt = C.loadDebt(sheet.tabs.debt_history);
    return { flows: flows.map((f) => ({ 날짜: f.날짜, 통화: f.통화, 금액: f.금액, 메모: f.메모 })), debt: debt.map((d) => ({ 날짜: d.날짜, 부채: d.부채, 메모: d.메모 })) };
  }
  if (path === "/api/flows" && m === "POST") {
    const date = C.toDate(body.날짜), ccy = s(body.통화) || "KRW", amt = numOrNaN(body.금액);
    if (!date) throw bad("날짜를 확인해 주세요.");
    if (!CCYS.includes(ccy)) throw bad("통화는 KRW/USD/EUR/JPY 중 하나예요.");
    if (!C.notNaN(amt) || amt === 0) throw bad("금액이 0이거나 비어 있어요 (출금은 음수).");
    await appendRow(env, p.sheet, "flows", C.SCHEMAS.flows, { 날짜: date, 통화: ccy, 금액: amt, 메모: s(body.메모) });
    await after(env, p);
    return { ok: true };
  }
  if (path === "/api/flows" && m === "PUT") {
    const rows = (body.rows || []).map((r) => ({ 날짜: C.toDate(r.날짜), 통화: s(r.통화) || "KRW", 금액: numOrNaN(r.금액), 메모: s(r.메모) }))
      .filter((r) => r.날짜 && C.notNaN(r.금액));
    await writeTab(env, p.sheet, "flows", C.SCHEMAS.flows, rows);
    await after(env, p);
    return { ok: true, rows: rows.length };
  }

  // ---------- 부채 ----------
  if (path === "/api/debt" && m === "POST") {
    const date = C.toDate(body.날짜), debt = numOrNaN(body.부채);
    if (!date) throw bad("날짜를 확인해 주세요.");
    if (!C.notNaN(debt) || debt < 0) throw bad("부채 잔액을 0 이상 숫자로 입력해 주세요.");
    const tabs = await fresh(env, p, ["debt_history"]);
    const rows = C.loadDebt(tabs.debt_history).filter((d) => d.날짜 !== date);
    rows.push({ 날짜: date, 부채: debt, 메모: s(body.메모) });
    rows.sort((a, b) => (a.날짜 < b.날짜 ? -1 : a.날짜 > b.날짜 ? 1 : 0));
    await writeTab(env, p.sheet, "debt_history", C.SCHEMAS.debt_history, rows);
    await after(env, p);
    return { ok: true };
  }
  if (path === "/api/debt" && m === "DELETE") {
    const date = C.toDate(url.searchParams.get("date"));
    const tabs = await fresh(env, p, ["debt_history"]);
    const rows = C.loadDebt(tabs.debt_history).filter((d) => d.날짜 !== date);
    await writeTab(env, p.sheet, "debt_history", C.SCHEMAS.debt_history, rows);
    await after(env, p);
    return { ok: true };
  }

  // ---------- 종목 메모 (보유) ----------
  if (path === "/api/notes" && m === "PUT") {
    const tabs = await fresh(env, p, ["stock_notes"]);
    const H = C.SCHEMAS.stock_notes;
    const edited = (body.rows || []).map((r) => ({
      종목: s(r.종목), 목표가_상단: cell(numOrNaN(r.목표가_상단)), 목표가_하단: cell(numOrNaN(r.목표가_하단)),
      업사이드_메모: s(r.업사이드_메모), 다운사이드_메모: s(r.다운사이드_메모), 업데이트일: s(r.업데이트일) || today,
    })).filter((r) => r.종목);
    const names = new Set(edited.map((r) => r.종목));
    const others = tabs.stock_notes.filter((r) => s(r["종목"]) && !names.has(s(r["종목"]))); // 보유 외 종목 메모는 그대로
    await writeTab(env, p.sheet, "stock_notes", H, [...edited, ...others]);
    await after(env, p);
    return { ok: true, rows: edited.length };
  }

  // ---------- 관찰 종목 ----------
  if (path === "/api/watchlist" && m === "POST") {
    const name = s(body.종목), sym = s(body.심볼), ccy = s(body.통화) || "KRW";
    if (!name || !sym) throw bad("종목명과 심볼을 모두 입력해 주세요.");
    if (!CCYS.includes(ccy)) throw bad("통화는 KRW/USD/EUR/JPY 중 하나예요.");
    const tabs = await fresh(env, p, ["snapshots", "ticker_map", "watchlist"]);
    const latest = C.snapshotAtOrBefore(C.loadSnapshots(tabs.snapshots), today);
    if (latest && latest.rows.some((r) => r.종목 === name)) throw bad(`'${name}'은 이미 보유 종목이에요.`);
    const tmap = C.loadMap(tabs.ticker_map, "종목", "yfinance_symbol");
    tmap[name] = sym;
    await writeTab(env, p.sheet, "ticker_map", C.SCHEMAS.ticker_map, Object.keys(tmap).sort().map((k) => ({ 종목: k, yfinance_symbol: tmap[k] })));
    const exists = tabs.watchlist.some((r) => s(r["종목"]) === name);
    if (!exists) {
      await writeTab(env, p.sheet, "watchlist", C.SCHEMAS.watchlist, [...tabs.watchlist, { 종목: name, 통화: ccy, 목표가_상단: "", 목표가_하단: "", 업사이드_메모: "", 다운사이드_메모: "", 업데이트일: "" }]);
    }
    await after(env, p);
    return { ok: true, status: exists ? "exists" : "added" };
  }
  if (path === "/api/watchlist" && m === "PUT") {
    const tabs = await fresh(env, p, ["watchlist"]);
    const ccyOf = new Map(tabs.watchlist.map((r) => [s(r["종목"]), s(r["통화"])]));
    const rows = (body.rows || []).map((r) => ({
      종목: s(r.종목), 통화: s(r.통화) || ccyOf.get(s(r.종목)) || "KRW",
      목표가_상단: cell(numOrNaN(r.목표가_상단)), 목표가_하단: cell(numOrNaN(r.목표가_하단)),
      업사이드_메모: s(r.업사이드_메모), 다운사이드_메모: s(r.다운사이드_메모), 업데이트일: s(r.업데이트일) || today,
    })).filter((r) => r.종목);
    await writeTab(env, p.sheet, "watchlist", C.SCHEMAS.watchlist, rows);
    await after(env, p);
    return { ok: true, rows: rows.length };
  }

  // ---------- 순서 ----------
  if (path === "/api/order" && m === "PUT") {
    const entries = Object.entries(body.order || {}).map(([t, r]) => ({ 종목: s(t), 순서: Number.isFinite(+r) ? Math.trunc(+r) : 99 })).filter((r) => r.종목);
    entries.sort((a, b) => a.순서 - b.순서);
    await writeTab(env, p.sheet, "portfolio_order", C.SCHEMAS.portfolio_order, entries);
    await after(env, p);
    return { ok: true, rows: entries.length };
  }

  // ---------- 설정 ----------
  if (path === "/api/settings" && m === "GET") {
    const sheet = { tabs: await loadSheetFresh(env, p) }; // 편집 화면은 캐시 말고 시트 원본 (직접 편집분 덮어쓰기 방지)
    const cats = C.loadMap(sheet.tabs.categories, "종목", "카테고리");
    const tm = C.loadMap(sheet.tabs.ticker_map, "종목", "yfinance_symbol");
    const codes = (await env.KV.get("px:codes", "json")) || {};
    const px = await loadPrices(env);
    return {
      sheetId: p.sheet,
      categories: Object.keys(cats).sort().map((k) => ({ 종목: k, 카테고리: cats[k] })),
      tickers: Object.keys(tm).sort().map((k) => {
        const sym = tm[k], cur = px.current.prices[sym];
        const kind = sym ? X.classify(sym).kind : "";
        return { 종목: k, 심볼: sym, 출처: cur?.src || "", 시세: cur?.p ?? null, 네이버코드: kind === "world" ? codes[sym] ?? "" : kind === "kr" ? sym.slice(0, 6) : "" };
      }),
    };
  }
  if (path === "/api/categories" && m === "PUT") {
    const rows = (body.rows || []).map((r) => ({ 종목: s(r.종목), 카테고리: s(r.카테고리) })).filter((r) => r.종목);
    const map = new Map(rows.map((r) => [r.종목, r.카테고리]));
    await writeTab(env, p.sheet, "categories", C.SCHEMAS.categories, [...map.keys()].sort().map((k) => ({ 종목: k, 카테고리: map.get(k) })));
    await after(env, p);
    return { ok: true, rows: map.size };
  }
  if (path === "/api/tickers" && m === "PUT") {
    const rows = (body.rows || []).map((r) => ({ 종목: s(r.종목), yfinance_symbol: s(r.심볼 ?? r.yfinance_symbol) })).filter((r) => r.종목);
    const map = new Map(rows.map((r) => [r.종목, r.yfinance_symbol]));
    await writeTab(env, p.sheet, "ticker_map", C.SCHEMAS.ticker_map, [...map.keys()].sort().map((k) => ({ 종목: k, yfinance_symbol: map.get(k) })));
    await after(env, p);
    return { ok: true, rows: map.size };
  }

  return null; // 해당 없음
}
