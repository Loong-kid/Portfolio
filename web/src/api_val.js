// 종목 분석 (관리자 전용): 재무 데이터 + 내 추정(시트 valuation 탭).
// 계산(Forward 지표·목표가·Reverse DCF·성장률)은 입력하는 대로 바로 보이게 화면에서 한다.
import * as C from "./calc.js";
import { readTabs, writeTab, ensureTab } from "./google.js";
import { loadSheet, loadPrices, loadSheetFresh } from "./store.js";
import { currentFx } from "./api_view.js";
import { getFundamentals } from "./fundamentals.js";
import { getBars, withLive } from "./technical.js";
import { Budget, getJson, fetchCurrent } from "./prices.js";

// 금액 칸 단위: 재무 통화가 KRW 면 억원, 그 외는 백만 (USD·EUR·JPY …). 할인율·영구성장률은 % 숫자.
export const VAL_COLS = [
  "종목",
  "PER_약세", "PER_기준", "PER_강세",
  "할인율", "영구성장률", "DCF_기준", "주식수",
  // 기술적 분석: 이동평균 기간, 진입, 손절 방식(ATR·이평·저점·비율·가격)과 각 방식의 값
  "TA_단기", "TA_장기", "진입일", "진입가", "매수_희망가",
  "손절_방식", "손절_ATR배수", "손절_이평", "손절_여유", "손절_저점일", "손절_비율", "손절_가격",
  "메모", "업데이트일",
];
// 분기 추정은 따로 한 줄씩: 종목 · 분기(결산월 YYYY.MM) · 매출 · 영업이익 · 순이익
export const Q_COLS = ["종목", "분기", "매출", "영업이익", "순이익"];
const Q_F = { 매출: "rev", 영업이익: "oi", 순이익: "ni" };
const TEXT = new Set(["종목", "DCF_기준", "메모", "업데이트일", "진입일", "손절_방식"]);
const s = (v) => String(v ?? "").trim();
const num = (v) => (typeof v === "number" ? v : C.toNum(String(v ?? "").replace(/,/g, "")));
const bad = (msg) => { const e = new Error(msg); e.status = 400; return e; };
const tradable = (t) => t && !C.isCashLike(t) && !String(t).includes("→");

/** 분석할 종목: 보유(최근 스냅샷) + 관찰 */
function items(tabs, today) {
  const tmap = C.loadMap(tabs.ticker_map, "종목", "yfinance_symbol");
  const latest = C.snapshotAtOrBefore(C.loadSnapshots(tabs.snapshots), today);
  const out = [], seen = new Set();
  for (const r of latest ? latest.rows : []) {
    if (!tradable(r.종목) || seen.has(r.종목)) continue;
    seen.add(r.종목);
    out.push({ 종목: r.종목, 심볼: tmap[r.종목] || "", 통화: r.통화 || "KRW", 구분: "보유", 수량: r.수량, 평균단가: r.평균단가 });
  }
  for (const w of tabs.watchlist) {
    const t = s(w["종목"]);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ 종목: t, 심볼: tmap[t] || "", 통화: s(w["통화"]) || "KRW", 구분: "보유 예정" });
  }
  return out;
}

function parseRow(r) {
  if (!r) return null;
  const o = {};
  for (const c of VAL_COLS) o[c] = TEXT.has(c) ? s(r[c]) : (Number.isNaN(num(r[c])) ? null : num(r[c]));
  return o;
}

/** 분기 표기 정리: "2026.12" · "2026-12" · "202612" → "2026.12" */
function normQ(v) {
  const m = s(v).replace(/^'/, "").match(/^(\d{4})[.\-/ ]?(\d{1,2})$/);
  if (!m || +m[2] < 1 || +m[2] > 12) return null;
  return `${m[1]}.${m[2].padStart(2, "0")}`;
}
function parseQuarters(rows, name) {
  const out = [];
  for (const r of rows) {
    if (s(r["종목"]) !== name) continue;
    const k = normQ(r["분기"]);
    if (!k) continue;
    const q = { k };
    for (const [c, f] of Object.entries(Q_F)) { const v = num(r[c]); q[f] = Number.isNaN(v) ? null : v; }
    out.push(q);
  }
  return out.sort((a, b) => (a.k < b.k ? -1 : 1));
}

const CCYS = ["KRW", "USD", "EUR", "JPY"];
/** 심볼 확인: Yahoo 차트 메타로 가격·통화 */
async function probe(sym) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, new Budget(1));
  const meta = j.chart?.result?.[0]?.meta;
  if (!meta || !(Number(meta.regularMarketPrice) > 0)) throw new Error("가격 없음");
  return { sym, ccy: meta.currency || "", p: Number(meta.regularMarketPrice) };
}

export async function handleVal(req, env, ctx, url, p) {
  const path = url.pathname, m = req.method;
  const today = C.todayKst();

  // 기술적 분석: 일봉 (종목 목록에 있는 것만)
  if (path === "/api/valuation/ta" && m === "GET") {
    const sheet = await loadSheet(env, ctx, p);
    const item = items(sheet.tabs, today).find((i) => i.종목 === url.searchParams.get("name"));
    if (!item) throw bad("목록에 없는 종목이에요.");
    if (!item.심볼) throw bad("설정 탭에서 이 종목의 심볼(티커)을 먼저 넣어 주세요.");
    const [ta, px] = await Promise.all([
      getBars(env, item.심볼, { force: url.searchParams.get("refresh") === "1", budget: new Budget(4) }),
      loadPrices(env),
    ]);
    const cur = px.current.prices[item.심볼];
    return { sym: item.심볼, at: ta.at, warn: ta.warn || null, bars: withLive(ta.bars, cur) };
  }
  // 보유 예정 종목 추가: 심볼을 실제로 조회해 확인하고 통화도 거기서 알아낸다
  if (path === "/api/valuation/item" && m === "POST") {
    const body = await req.json().catch(() => ({}));
    const name = s(body.종목);
    let raw = s(body.심볼).toUpperCase().replace(/\s+/g, "");
    if (!name) throw bad("종목명을 넣어 주세요.");
    if (!raw) throw bad("심볼(티커)이나 종목코드를 넣어 주세요.");
    const cands = /^\d{6}$/.test(raw) ? [`${raw}.KS`, `${raw}.KQ`] : [raw];
    let hit = null;
    for (const c of cands) { hit = await probe(c).catch(() => null); if (hit) break; }
    if (!hit) throw bad(`'${raw}' 의 가격을 찾지 못했어요. 표기를 확인해 주세요 (예: NVDA · 005930.KS · 8725.T · AIXA.DE).`);
    const ccy = s(body.통화) || hit.ccy;
    if (!CCYS.includes(ccy)) throw bad(`이 종목의 통화(${hit.ccy || "알 수 없음"})는 아직 지원하지 않아요 (KRW·USD·EUR·JPY).`);
    const tabs = await readTabs(env, p.sheet, ["snapshots", "ticker_map", "watchlist"]);
    const latest = C.snapshotAtOrBefore(C.loadSnapshots(tabs.snapshots), today);
    if (latest && latest.rows.some((r) => r.종목 === name)) throw bad(`'${name}'은 이미 보유 종목이에요.`);
    const tmap = C.loadMap(tabs.ticker_map, "종목", "yfinance_symbol");
    tmap[name] = hit.sym;
    await writeTab(env, p.sheet, "ticker_map", C.SCHEMAS.ticker_map, Object.keys(tmap).sort().map((k) => ({ 종목: k, yfinance_symbol: tmap[k] })));
    const exists = tabs.watchlist.some((r) => s(r["종목"]) === name);
    if (!exists) {
      await writeTab(env, p.sheet, "watchlist", C.SCHEMAS.watchlist, [...tabs.watchlist, { 종목: name, 통화: ccy, 목표가_상단: "", 목표가_하단: "", 업사이드_메모: "", 다운사이드_메모: "", 업데이트일: today }]);
    }
    await loadSheetFresh(env, p);
    return { ok: true, 종목: name, 심볼: hit.sym, 통화: ccy, status: exists ? "exists" : "added" };
  }
  // 보유 예정에서 빼기 (관찰 목록에서만 지움 — 심볼·내 추정은 남겨서 다시 넣으면 그대로)
  if (path === "/api/valuation/item" && m === "DELETE") {
    const name = s(url.searchParams.get("name"));
    const tabs = await readTabs(env, p.sheet, ["watchlist"]);
    const rows = tabs.watchlist.filter((r) => s(r["종목"]) && s(r["종목"]) !== name);
    if (rows.length === tabs.watchlist.filter((r) => s(r["종목"])).length) throw bad("보유 예정 목록에 없는 종목이에요.");
    await writeTab(env, p.sheet, "watchlist", C.SCHEMAS.watchlist, rows);
    await loadSheetFresh(env, p);
    return { ok: true };
  }
  if (path !== "/api/valuation") return null;

  if (m === "GET") {
    const sheet = await loadSheet(env, ctx, p);
    const list = items(sheet.tabs, today);
    const name = url.searchParams.get("name");
    const item = list.find((i) => i.종목 === name) || list[0];
    if (!item) return { items: list, card: null };
    if (!item.심볼) return { items: list, card: { item, error: "설정 탭에서 이 종목의 심볼(티커)을 먼저 넣어 주세요." } };
    const force = url.searchParams.get("refresh") === "1";
    const [finR, px, vt] = await Promise.all([
      getFundamentals(env, item.심볼, { force, budget: new Budget(8) }).then((f) => ({ f }), (e) => ({ e: String(e.message || e) })),
      loadPrices(env),
      readTabs(env, p.sheet, ["valuation", "valuation_q"]), // 내 추정은 캐시 말고 시트 원본
    ]);
    const row = vt.valuation.find((r) => s(r["종목"]) === item.종목);
    let cur = px.current.prices[item.심볼];
    if (!cur) cur = (await fetchCurrent([item.심볼], {}, new Budget(2)).catch(() => ({})))[item.심볼]; // 막 추가한 종목: 크론 전이라 바로 조회
    const hope = new Map(vt.valuation.map((r) => [s(r["종목"]), num(r["매수_희망가"])]));
    for (const i of list) {
      const c = i === item ? cur : px.current.prices[i.심볼];
      i.현재가 = c?.p ?? null;
      const h = hope.get(i.종목);
      i.매수_희망가 = Number.isNaN(h) || h == null ? null : h;
    }
    return {
      items: list,
      card: {
        item,
        price: cur ? { p: cur.p, d: cur.d, src: cur.src } : null,
        fx: currentFx(px),
        fin: finR.f || null,
        finError: finR.e || null,
        inputs: { ...(parseRow(row) || {}), quarters: parseQuarters(vt.valuation_q, item.종목) },
      },
    };
  }

  if (m === "PUT") {
    const body = await req.json().catch(() => ({}));
    const name = s(body.종목);
    if (!name) throw bad("종목이 비어 있어요.");
    const inp = body.inputs || {};
    const row = { 종목: name, 업데이트일: today };
    for (const c of VAL_COLS) {
      if (c === "종목" || c === "업데이트일") continue;
      if (TEXT.has(c)) row[c] = s(inp[c]);
      else { const v = num(inp[c]); row[c] = Number.isNaN(v) ? "" : v; }
    }
    // 분기 추정: 숫자가 하나라도 있는 분기만
    const qs = [];
    for (const q of Array.isArray(inp.quarters) ? inp.quarters.slice(0, 80) : []) {
      const k = normQ(q?.k);
      if (!k) continue;
      const qr = { 종목: name, 분기: `'${k}` }; // 작은따옴표: 시트가 2026.10 을 숫자 2026.1 로 바꾸지 않게
      let any = false;
      for (const [c, f] of Object.entries(Q_F)) {
        const v = num(q[f]);
        if (Number.isNaN(v) && s(q[f]) !== "") throw bad(`${k} ${c} 칸이 숫자가 아니에요.`);
        qr[c] = Number.isNaN(v) ? "" : v;
        if (!Number.isNaN(v)) any = true;
      }
      if (any) qs.push(qr);
    }
    await ensureTab(env, p.sheet, "valuation");
    await ensureTab(env, p.sheet, "valuation_q");
    const vt = await readTabs(env, p.sheet, ["valuation", "valuation_q"]);
    const rows = vt.valuation.filter((r) => s(r["종목"]) && s(r["종목"]) !== name); // 다른 종목은 시트 그대로
    rows.push(row);
    await writeTab(env, p.sheet, "valuation", VAL_COLS, rows);
    const keep = vt.valuation_q
      .filter((r) => s(r["종목"]) && s(r["종목"]) !== name)
      .map((r) => ({ ...r, 분기: normQ(r["분기"]) ? `'${normQ(r["분기"])}` : r["분기"] }));
    await writeTab(env, p.sheet, "valuation_q", Q_COLS, [...keep, ...qs.sort((a, b) => (a.분기 < b.분기 ? -1 : 1))]);
    return { ok: true, 업데이트일: today };
  }
  return null;
}
