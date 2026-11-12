// 종목 분석 (관리자 전용): 재무 데이터 + 내 추정(시트 valuation 탭).
// 계산(Forward 지표·목표가·역DCF·성장률)은 입력하는 대로 바로 보이게 화면에서 한다.
import * as C from "./calc.js";
import { readTabs, writeTab, ensureTab } from "./google.js";
import { loadSheet, loadPrices } from "./store.js";
import { currentFx } from "./api_view.js";
import { getFundamentals } from "./fundamentals.js";
import { Budget } from "./prices.js";

// 금액 칸 단위: 재무 통화가 KRW 면 억원, 그 외는 백만 (USD·EUR·JPY …). 할인율·영구성장률은 % 숫자.
export const VAL_COLS = [
  "종목",
  "추정1_연도", "추정1_매출", "추정1_영업이익", "추정1_순이익",
  "추정2_연도", "추정2_매출", "추정2_영업이익", "추정2_순이익",
  "PER_약세", "PER_기준", "PER_강세",
  "할인율", "영구성장률", "DCF_기준", "주식수", "메모", "업데이트일",
];
const TEXT = new Set(["종목", "DCF_기준", "메모", "업데이트일"]);
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
    out.push({ 종목: r.종목, 심볼: tmap[r.종목] || "", 통화: r.통화 || "KRW", 구분: "보유" });
  }
  for (const w of tabs.watchlist) {
    const t = s(w["종목"]);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({ 종목: t, 심볼: tmap[t] || "", 통화: s(w["통화"]) || "KRW", 구분: "관찰" });
  }
  return out;
}

function parseRow(r) {
  if (!r) return null;
  const o = {};
  for (const c of VAL_COLS) o[c] = TEXT.has(c) ? s(r[c]) : (Number.isNaN(num(r[c])) ? null : num(r[c]));
  return o;
}

export async function handleVal(req, env, ctx, url, p) {
  const path = url.pathname, m = req.method;
  if (path !== "/api/valuation") return null;
  const today = C.todayKst();

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
      readTabs(env, p.sheet, ["valuation"]), // 내 추정은 캐시 말고 시트 원본
    ]);
    const row = vt.valuation.find((r) => s(r["종목"]) === item.종목);
    const cur = px.current.prices[item.심볼];
    return {
      items: list,
      card: {
        item,
        price: cur ? { p: cur.p, d: cur.d, src: cur.src } : null,
        fx: currentFx(px),
        fin: finR.f || null,
        finError: finR.e || null,
        inputs: parseRow(row),
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
    await ensureTab(env, p.sheet, "valuation");
    const vt = await readTabs(env, p.sheet, ["valuation"]);
    const rows = vt.valuation.filter((r) => s(r["종목"]) && s(r["종목"]) !== name); // 다른 종목은 시트 그대로
    rows.push(row);
    await writeTab(env, p.sheet, "valuation", VAL_COLS, rows);
    return { ok: true, 업데이트일: today };
  }
  return null;
}
