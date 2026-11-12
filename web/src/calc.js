// portfolio.py 의 계산을 그대로 옮긴 것. (파이썬 판을 정답지로 대조 — scripts/oracle 참고)
// 날짜는 전부 "YYYY-MM-DD" 문자열로 다룬다 (사전순 비교 = 날짜순).
// 시트 값은 표시 문자열 그대로 들어오므로 pandas.to_numeric(errors="coerce") 처럼 파싱한다.

export const CASH_TICKERS = new Set(["KRW현금", "USD현금", "EUR현금", "JPY현금"]);
export const ACCOUNT_TICKERS = new Set(["개인연금", "퇴직연금"]);
export const DEFAULT_FX = { KRW: 1.0, USD: 1520.0, EUR: 1763.0, JPY: 9.53 };
export const isCashLike = (t) => CASH_TICKERS.has(t) || ACCOUNT_TICKERS.has(t);

export const SCHEMAS = {
  snapshots: ["날짜", "종목", "통화", "수량", "평균단가", "현재가", "환율", "평가액"],
  flows: ["날짜", "통화", "금액", "메모"],
  debt_history: ["날짜", "부채", "메모"],
  nav_anchors: ["날짜", "총자산", "순자산", "좌수_총", "좌수_순", "기준가_총자산", "기준가_순자산"],
  stock_notes: ["종목", "목표가_상단", "목표가_하단", "업사이드_메모", "다운사이드_메모", "업데이트일"],
  watchlist: ["종목", "통화", "목표가_상단", "목표가_하단", "업사이드_메모", "다운사이드_메모", "업데이트일"],
  categories: ["종목", "카테고리"],
  ticker_map: ["종목", "yfinance_symbol"],
  portfolio_order: ["종목", "순서"],
};

// ---------- 파싱 ----------
export function toNum(v) {
  if (typeof v === "number") return v;
  if (v == null) return NaN;
  const s = String(v).trim();
  if (s === "") return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
export const notNaN = (x) => typeof x === "number" && !Number.isNaN(x);

/** "2026-6-1", "2026/06/01", "2026-06-01 00:00:00" → "2026-06-01". 실패 시 null. */
export function toDate(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${m[1]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** pandas sort_values 를 흉내내되 안정 정렬(같은 날짜는 시트 순서 유지). */
const byDate = (a, b) => (a.날짜 < b.날짜 ? -1 : a.날짜 > b.날짜 ? 1 : 0);

export function loadSnapshots(rows) {
  return rows
    .map((r) => ({
      날짜: toDate(r["날짜"]),
      종목: String(r["종목"] ?? "").trim(),
      통화: String(r["통화"] ?? "").trim() || "KRW",
      수량: toNum(r["수량"]), 평균단가: toNum(r["평균단가"]),
      현재가: toNum(r["현재가"]), 환율: toNum(r["환율"]), 평가액: toNum(r["평가액"]),
    }))
    .filter((r) => r.날짜)
    .sort(byDate);
}

export function loadFlows(rows) {
  return rows
    .map((r) => ({ 날짜: toDate(r["날짜"]), 통화: String(r["통화"] ?? "").trim() || "KRW", 금액: toNum(r["금액"]), 메모: String(r["메모"] ?? "") }))
    .filter((r) => r.날짜 && notNaN(r.금액))
    .sort(byDate);
}

export function loadDebt(rows) {
  return rows
    .map((r) => ({ 날짜: toDate(r["날짜"]), 부채: toNum(r["부채"]), 메모: String(r["메모"] ?? "") }))
    .filter((r) => r.날짜 && notNaN(r.부채))
    .sort(byDate);
}

export function loadAnchors(rows) {
  const cols = ["총자산", "순자산", "좌수_총", "좌수_순", "기준가_총자산", "기준가_순자산"];
  return rows
    .map((r) => { const o = { 날짜: toDate(r["날짜"]) }; for (const c of cols) o[c] = toNum(r[c]); return o; })
    .filter((r) => r.날짜 && notNaN(r.총자산))
    .sort(byDate);
}

export function loadMap(rows, keyCol, valCol) {
  const out = {};
  for (const r of rows) {
    const k = String(r[keyCol] ?? "").trim();
    if (k) out[k] = String(r[valCol] ?? "").trim();
  }
  return out;
}

export function loadOrder(rows) {
  const out = {};
  for (const r of rows) {
    const t = String(r["종목"] ?? "").trim();
    const n = toNum(r["순서"] === "" || r["순서"] == null ? 0 : r["순서"]);
    if (t && notNaN(n)) out[t] = Math.trunc(n);
  }
  return out;
}

export function loadNotes(rows, headers) {
  return rows.map((r) => {
    const o = {};
    for (const h of headers) o[h] = r[h] ?? "";
    o.목표가_상단 = toNum(o.목표가_상단);
    o.목표가_하단 = toNum(o.목표가_하단);
    return o;
  });
}

// ---------- 스냅샷 조회 ----------
export function snapshotDates(snaps) {
  return [...new Set(snaps.map((r) => r.날짜))].sort();
}

/** 날짜 ≤ asOf 인 가장 최근 스냅샷. 같은 종목 중복은 마지막 행 유지. → {date, rows} | null */
export function snapshotAtOrBefore(snaps, asOf) {
  const valid = snaps.filter((r) => r.날짜 <= asOf);
  if (!valid.length) return null;
  const date = valid.reduce((m, r) => (r.날짜 > m ? r.날짜 : m), valid[0].날짜);
  return { date, rows: dedupeLast(valid.filter((r) => r.날짜 === date)) };
}

export function snapshotOn(snaps, date) {
  return dedupeLast(snaps.filter((r) => r.날짜 === date));
}

function dedupeLast(rows) {
  const m = new Map();
  for (const r of rows) { m.delete(r.종목); m.set(r.종목, r); }
  // pandas drop_duplicates(keep="last") 는 원래 순서상 마지막 등장 위치를 유지
  const lastIdx = new Map(rows.map((r, i) => [r.종목, i]));
  return [...m.values()].sort((a, b) => lastIdx.get(a.종목) - lastIdx.get(b.종목));
}

// ---------- 현재 평가 (value_holdings) ----------
/**
 * holdings: [{종목, 통화, 수량, 평균단가, 현재가(스냅샷)}]
 * prices: {종목: 현재가}, fx: {통화: 환율}
 */
export function valueHoldings(holdings, prices, fx, catMap) {
  return holdings.map((h) => {
    const rate = notNaN(fx[h.통화]) ? fx[h.통화] : (DEFAULT_FX[h.통화] ?? 1.0);
    let 현재가, 평가액, 가격출처;
    if (isCashLike(h.종목)) {
      현재가 = 1.0; 평가액 = h.수량 * rate; 가격출처 = "cash";
    } else {
      const live = prices[h.종목];
      const snap = h.현재가;
      if (notNaN(live) && live > 0) { 현재가 = live; 평가액 = h.수량 * live * rate; 가격출처 = "live"; }
      else if (notNaN(snap) && snap > 0) { 현재가 = snap; 평가액 = h.수량 * snap * rate; 가격출처 = "snapshot"; }
      else { 현재가 = NaN; 평가액 = NaN; 가격출처 = "missing"; }
    }
    const 원가 = h.수량 * h.평균단가 * rate;
    const 평가손익 = 평가액 - 원가;
    const 수익률 = Math.abs(원가) > 1e-6 ? 평가손익 / 원가 : 0.0;
    return {
      종목: h.종목, 카테고리: catMap[h.종목] ?? "기타", 통화: h.통화, 환율: rate,
      수량: h.수량, 평균단가: h.평균단가, 현재가, 평가액, 원가, 평가손익, 수익률, 가격출처,
    };
  });
}

/** pandas sum 은 NaN 을 건너뛴다. */
export const nansum = (arr) => arr.reduce((s, x) => (notNaN(x) ? s + x : s), 0);

export function categoryBreakdown(valued) {
  const g = new Map();
  for (const v of valued) g.set(v.카테고리, (g.get(v.카테고리) ?? 0) + (notNaN(v.평가액) ? v.평가액 : 0));
  const total = [...g.values()].reduce((a, b) => a + b, 0);
  return [...g.entries()]
    .map(([카테고리, 평가액]) => ({ 카테고리, 평가액, 비중: total ? 평가액 / total : 0 }))
    .sort((a, b) => b.평가액 - a.평가액);
}

// ---------- 시계열 (compute_nav_history) ----------
export function flowKrw(f) {
  const ccy = f.통화 || "KRW";
  const fx = ccy === "KRW" ? 1.0 : (DEFAULT_FX[ccy] ?? 1.0);
  return f.금액 * fx;
}

/** 월~금 영업일 목록 (pd.bdate_range). */
export function businessDays(start, end) {
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  const e = new Date(end + "T00:00:00Z");
  while (d <= e) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** 정렬된 [[date, value]...] 에서 date ≤ d 인 마지막 값. 없으면 undefined. */
export function lastAtOrBefore(series, d) {
  if (!series || !series.length) return undefined;
  let lo = 0, hi = series.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid][0] <= d) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? series[ans][1] : undefined;
}

function debtAt(debt, d) {
  let v = 0.0;
  for (const r of debt) { if (r.날짜 <= d) v = r.부채; else break; }
  return v;
}

/**
 * priceHist: {종목: [[date, close], ...]} (날짜 오름차순, 현지 통화)
 * fxHist: {USD|EUR|JPY: [[date, rate], ...]}
 */
export function computeNavHistory({ snaps, flows, debt, anchors, priceHist, fxHist, start, end, today }) {
  const hasSnap = snaps.length > 0;
  const hasAnchor = anchors.length > 0;
  if (!hasSnap && !hasAnchor) return [];

  const snapDates = hasSnap ? snapshotDates(snaps) : [];
  const firstSnap = hasSnap ? snapDates[0] : null;
  const rowsByDate = new Map();
  for (const r of snaps) { if (!rowsByDate.has(r.날짜)) rowsByDate.set(r.날짜, []); rowsByDate.get(r.날짜).push(r); }

  const starts = [];
  if (hasAnchor) starts.push(anchors[0].날짜);
  if (hasSnap) starts.push(firstSnap);
  const overallStart = starts.sort()[0];
  start = start ?? overallStart;
  end = end ?? today;
  if (end < start) return [];
  const days = businessDays(start, end);
  if (!days.length) return [];

  const anchorLookup = new Map();
  for (const a of anchors) anchorLookup.set(a.날짜, a);
  const anchorDates = [...anchorLookup.keys()].sort();

  let initUnitsT = null, initUnitsN = null;
  const withUnits = anchors.filter((a) => notNaN(a.좌수_총));
  if (withUnits.length) {
    initUnitsT = withUnits[0].좌수_총;
    initUnitsN = notNaN(withUnits[0].좌수_순) ? withUnits[0].좌수_순 : initUnitsT;
  }

  const dailyFlow = new Map();
  for (const f of flows) dailyFlow.set(f.날짜, (dailyFlow.get(f.날짜) ?? 0) + flowKrw(f));

  const navAt = (holdings, d) => {
    let total = 0.0;
    for (const row of holdings) {
      const ccy = row.통화 || "KRW";
      const qty = row.수량;
      let fx;
      if (ccy === "KRW") fx = 1.0;
      else {
        const s = fxHist[ccy];
        if (s && s.length) { const v = lastAtOrBefore(s, d); fx = v !== undefined ? v : (DEFAULT_FX[ccy] ?? 1.0); }
        else fx = DEFAULT_FX[ccy] ?? 1.0;
      }
      if (isCashLike(row.종목)) total += qty * fx;
      else {
        const ph = priceHist[row.종목];
        let price;
        if (ph && ph.length) { const v = lastAtOrBefore(ph, d); price = v !== undefined ? v : row.평균단가; }
        else price = row.평균단가;
        total += qty * price * fx;
      }
    }
    return total;
  };

  const holdingsAt = (d) => {
    let snapD = null;
    for (const sd of snapDates) { if (sd <= d) snapD = sd; else break; }
    return snapD ? rowsByDate.get(snapD) : [];
  };

  const storedNav = (d) => {
    if (!rowsByDate.has(d)) return null;
    const sub = rowsByDate.get(d);
    if (sub.some((r) => !notNaN(r.평가액))) return null;
    return sub.reduce((s, r) => s + r.평가액, 0);
  };

  const navForDay = (d) => {
    if (anchorLookup.has(d)) {
      const a = anchorLookup.get(d);
      return [a.총자산, notNaN(a.순자산) ? a.순자산 : null];
    }
    const stored = storedNav(d);
    if (stored !== null) return [stored, null];
    if (hasSnap && d >= firstSnap) return [navAt(holdingsAt(d), d), null];
    let prior = null;
    for (const ad of anchorDates) { if (ad <= d) prior = ad; else break; }
    if (prior) { const a = anchorLookup.get(prior); return [a.총자산, notNaN(a.순자산) ? a.순자산 : null]; }
    return [0.0, null];
  };

  const out = [];
  let unitsT = 0.0, unitsN = 0.0, prevDebt = 0.0;
  days.forEach((d, i) => {
    const [navT, navNOverride] = navForDay(d);
    let debtToday = debtAt(debt, d);
    let navN;
    if (navNOverride !== null) { navN = navNOverride; debtToday = navT - navN; }
    else navN = navT - debtToday;
    const flowT = dailyFlow.get(d) ?? 0.0;
    const debtChange = i > 0 ? debtToday - prevDebt : 0.0;
    const flowN = flowT - debtChange;
    let upT, upN;
    if (i === 0) {
      if (initUnitsT !== null) { unitsT = initUnitsT; unitsN = initUnitsN !== null ? initUnitsN : initUnitsT; }
      else if (navT > 0) { unitsT = navT / 1000.0; unitsN = navN > 0 ? navN / 1000.0 : unitsT; }
      else { unitsT = 0.0; unitsN = 0.0; }
      upT = unitsT > 0 ? navT / unitsT : 0.0;
      upN = unitsN > 0 ? navN / unitsN : 0.0;
    } else {
      const prev = out[out.length - 1];
      if (flowT !== 0 && prev.기준가_총자산 > 0) unitsT += flowT / prev.기준가_총자산;
      if (flowN !== 0 && prev.기준가_순자산 > 0) unitsN += flowN / prev.기준가_순자산;
      upT = unitsT > 0 ? navT / unitsT : 0.0;
      upN = unitsN > 0 ? navN / unitsN : 0.0;
    }
    if (anchorLookup.has(d)) {
      const a = anchorLookup.get(d);
      if (notNaN(a.좌수_총)) { unitsT = a.좌수_총; upT = unitsT > 0 ? navT / unitsT : 0.0; }
      if (notNaN(a.좌수_순)) { unitsN = a.좌수_순; upN = unitsN > 0 ? navN / unitsN : 0.0; }
      if (notNaN(a.기준가_총자산)) upT = a.기준가_총자산;
      if (notNaN(a.기준가_순자산)) upN = a.기준가_순자산;
    }
    out.push({
      날짜: d, 총자산: navT, 순자산: navN, 부채: debtToday,
      외부유입_총: i > 0 ? flowT : 0.0, 외부유입_순: i > 0 ? flowN : 0.0,
      좌수_총: unitsT, 좌수_순: unitsN, 기준가_총자산: upT, 기준가_순자산: upN,
    });
    prevDebt = debtToday;
  });
  return out;
}

// ---------- 금융수익금 (compute_income_summary) ----------
export function computeIncomeSummary(nav, flows, today) {
  if (!nav.length) return { status: "no nav history" };
  const h = nav.filter((r) => r.날짜 <= today);
  if (!h.length) return { status: "no rows ≤ today" };
  const startRow = h[0], lastRow = h[h.length - 1];
  const startDate = startRow.날짜;
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const hPre = h.filter((r) => r.날짜 < yearStart);
  const yearAnchor = hPre.length ? hPre[hPre.length - 1] : null;

  let flowTotal = 0.0, flowYtd = null;
  if (flows.length) {
    flowTotal = flows.filter((f) => f.날짜 > startDate && f.날짜 <= today).reduce((s, f) => s + flowKrw(f), 0);
    if (yearAnchor) flowYtd = flows.filter((f) => f.날짜 > yearAnchor.날짜 && f.날짜 <= today).reduce((s, f) => s + flowKrw(f), 0);
  }
  const cumIncome = lastRow.순자산 - startRow.순자산 - flowTotal;
  const ytdIncome = yearAnchor ? lastRow.순자산 - yearAnchor.순자산 - (flowYtd ?? 0.0) : null;
  return {
    start_date: startDate,
    start_nav_net: startRow.순자산, start_nav_total: startRow.총자산,
    current_nav_total: lastRow.총자산, current_nav_net: lastRow.순자산,
    debt_now: lastRow.부채, cum_inflow: flowTotal, cum_income: cumIncome, ytd_income: ytdIncome,
    year: +today.slice(0, 4),
    year_anchor_date: yearAnchor ? yearAnchor.날짜 : null,
    year_anchor_nav_net: yearAnchor ? yearAnchor.순자산 : null,
  };
}

// ---------- 시간 ----------
/** KST 기준 오늘 "YYYY-MM-DD" */
export function todayKst(now = new Date()) {
  return new Date(now.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
