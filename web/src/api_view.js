// 보기용 응답 만들기. 게스트에게는 금액(수량·평가액·평가손익·원가·총액)을 아예 보내지 않는다.
import * as C from "./calc.js";
import { withLatest } from "./prices.js";

const tradable = (t) => !C.isCashLike(t) && !String(t).includes("→");
const nn = (x) => (C.notNaN(x) ? x : null); // JSON 에 NaN 대신 null

export function currentFx(px) {
  const fx = { KRW: 1.0 };
  for (const c of ["USD", "EUR", "JPY"]) fx[c] = px.current.fx[c]?.p ?? C.DEFAULT_FX[c];
  return fx;
}

/** 종목명 → 현재가 (현지 통화) */
export function namePrices(tabs, px) {
  const tmap = C.loadMap(tabs.ticker_map, "종목", "yfinance_symbol");
  const out = {}, meta = {};
  for (const [name, sym] of Object.entries(tmap)) {
    const c = px.current.prices[sym];
    if (c && c.p > 0) { out[name] = c.p; meta[name] = { d: c.d, src: c.src, sym }; }
  }
  return { prices: out, meta, tmap };
}

export function buildPortfolio(p, role, tabs, px, today) {
  const isGuest = role !== "admin";
  const snaps = C.loadSnapshots(tabs.snapshots);
  const latest = C.snapshotAtOrBefore(snaps, today);
  const catMap = C.loadMap(tabs.categories, "종목", "카테고리");
  const order = C.loadOrder(tabs.portfolio_order);
  const fx = currentFx(px);
  const { prices, meta, tmap } = namePrices(tabs, px);
  const valued = latest ? C.valueHoldings(latest.rows, prices, fx, catMap) : [];

  const total = C.nansum(valued.map((v) => v.평가액));
  const pnl = C.nansum(valued.map((v) => v.평가손익));
  const cost = C.nansum(valued.map((v) => v.원가));

  // 종목별 비중 막대: 현금 묶기
  const bars = [];
  let cash = 0, hasCash = false;
  for (const v of valued) {
    if (C.CASH_TICKERS.has(v.종목)) { cash += C.notNaN(v.평가액) ? v.평가액 : 0; hasCash = true; }
    else bars.push({ 종목: v.종목, 카테고리: v.카테고리, 평가액: v.평가액 });
  }
  if (hasCash) bars.push({ 종목: "현금", 카테고리: "현금", 평가액: cash });
  const barTotal = C.nansum(bars.map((b) => b.평가액));

  const holdings = valued
    .map((v) => {
      const cashAcct = C.isCashLike(v.종목);
      const row = {
        종목: v.종목, 카테고리: v.카테고리, 통화: v.통화,
        환율: v.통화 === "KRW" ? null : nn(v.환율),
        평균단가: cashAcct ? null : nn(v.평균단가),
        현재가: nn(v.현재가),
        수익률: cashAcct ? null : nn(v.수익률),
        비중: total ? (C.notNaN(v.평가액) ? v.평가액 / total : null) : null,
        가격출처: v.가격출처,
        시세일: meta[v.종목]?.d ?? null,
        순서: order[v.종목] ?? 99,
      };
      if (!isGuest) {
        row.수량 = C.ACCOUNT_TICKERS.has(v.종목) || v.종목 === "KRW현금" ? null : nn(v.수량);
        row.평가액 = nn(v.평가액);
        row.평가손익 = cashAcct ? null : nn(v.평가손익);
      }
      return row;
    })
    .sort((a, b) => a.순서 - b.순서 || (b.비중 ?? -1) - (a.비중 ?? -1));

  const categories = C.categoryBreakdown(valued).map((c) => (isGuest ? { 카테고리: c.카테고리, 비중: c.비중 } : c));
  const barsOut = bars
    .map((b) => ({ 종목: b.종목, 카테고리: b.카테고리, 비중: barTotal ? (C.notNaN(b.평가액) ? b.평가액 / barTotal : 0) : 0, ...(isGuest ? {} : { 평가액: nn(b.평가액) }) }))
    .sort((a, b) => b.비중 - a.비중)
    .slice(0, 15);

  // 종목 메모 (보유) + 관찰 종목
  const heldSet = new Set((latest ? latest.rows : []).map((r) => r.종목).filter(tradable));
  const notesAll = C.loadNotes(tabs.stock_notes, C.SCHEMAS.stock_notes);
  const notesByName = new Map(notesAll.map((n) => [String(n.종목), n]));
  const holdingByName = new Map((latest ? latest.rows : []).map((r) => [r.종목, r]));
  const rr = (cur, up, down) => {
    const u = C.notNaN(cur) && C.notNaN(up) && cur > 0 ? ((up - cur) / cur) * 100 : NaN;
    const d = C.notNaN(cur) && C.notNaN(down) && cur > 0 ? ((down - cur) / cur) * 100 : NaN;
    return { 업사이드_pct: nn(u), 다운사이드_pct: nn(d), RR: C.notNaN(u) && C.notNaN(d) && d < 0 ? u / Math.abs(d) : null };
  };
  // 순서: 시트에 있는 메모 순서 → 메모 없는 보유 종목 (Streamlit 과 같음)
  const noteOrder = [...new Set([...notesAll.map((n) => String(n.종목)).filter((t) => heldSet.has(t)), ...heldSet])];
  const notes = noteOrder.map((t) => {
    const n = notesByName.get(t) || { 목표가_상단: NaN, 목표가_하단: NaN, 업사이드_메모: "", 다운사이드_메모: "", 업데이트일: "" };
    const h = holdingByName.get(t);
    const cur = prices[t];
    return {
      종목: t, 카테고리: catMap[t] ?? "기타", 통화: h?.통화 ?? "", 평균단가: nn(h?.평균단가), 현재가: nn(cur),
      목표가_상단: nn(n.목표가_상단), 목표가_하단: nn(n.목표가_하단), ...rr(cur, n.목표가_상단, n.목표가_하단),
      업사이드_메모: n.업사이드_메모 ?? "", 다운사이드_메모: n.다운사이드_메모 ?? "", 업데이트일: n.업데이트일 ?? "",
    };
  });
  const watchlist = C.loadNotes(tabs.watchlist, C.SCHEMAS.watchlist).filter((w) => String(w.종목).trim()).map((w) => {
    const cur = prices[w.종목];
    return {
      종목: w.종목, 심볼: tmap[w.종목] ?? "", 통화: w.통화, 현재가: nn(cur),
      목표가_상단: nn(w.목표가_상단), 목표가_하단: nn(w.목표가_하단), ...rr(cur, w.목표가_상단, w.목표가_하단),
      업사이드_메모: w.업사이드_메모 ?? "", 다운사이드_메모: w.다운사이드_메모 ?? "", 업데이트일: w.업데이트일 ?? "",
    };
  });

  const warnings = valued.filter((v) => v.가격출처 === "snapshot" || v.가격출처 === "missing").map((v) => ({ 종목: v.종목, 출처: v.가격출처 }));

  return {
    name: p.name, pid: p.id, role,
    latestSnapshot: latest ? latest.date : null,
    totals: isGuest ? null : { 평가액: total, 평가손익: pnl, 원가: cost, 수익률: cost ? pnl / cost : null },
    fx: isGuest ? null : fx,
    pricesAt: px.current.at || null,
    holdings, categories, bars: barsOut, notes, watchlist,
    warnings: isGuest ? [] : warnings,
  };
}

/** 자산 추이 (관리자 전용) */
export function buildNav(tabs, px, today) {
  const snaps = C.loadSnapshots(tabs.snapshots);
  const flows = C.loadFlows(tabs.flows);
  const debt = C.loadDebt(tabs.debt_history);
  const anchors = C.loadAnchors(tabs.nav_anchors);
  const tmap = C.loadMap(tabs.ticker_map, "종목", "yfinance_symbol");

  const priceHist = {};
  for (const t of new Set(snaps.map((r) => r.종목))) {
    if (!tradable(t)) continue;
    const sym = tmap[t];
    if (!sym) continue;
    priceHist[t] = withLatest(px.hist.s[sym]?.s, px.current.prices[sym]);
  }
  const fxHist = {};
  for (const c of ["USD", "EUR", "JPY"]) fxHist[c] = withLatest(px.hist.fx[c]?.s, px.current.fx[c]);

  const nav = C.computeNavHistory({ snaps, flows, debt, anchors, priceHist, fxHist, end: today, today });
  const income = C.computeIncomeSummary(nav, flows, today);
  const missingHist = [...new Set(snaps.map((r) => r.종목))].filter((t) => tradable(t) && tmap[t] && !(px.hist.s[tmap[t]]?.s?.length));
  return {
    nav, income,
    anchors: anchors.map((a) => ({ 날짜: a.날짜, 순자산: nn(a.순자산) })),
    snapshotCount: C.snapshotDates(snaps).length,
    debt: debt.map((d) => ({ 날짜: d.날짜, 부채: d.부채, 메모: d.메모 })),
    flows: flows.map((f) => ({ 날짜: f.날짜, krw: C.flowKrw(f) })), // 기간별 금융수익금 계산용
    missingHist,
  };
}
