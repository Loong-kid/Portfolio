// 재무 데이터 (종목 분석 카드용).
//  - Yahoo 재무 시계열: 전 시장 연간 4년 + 분기 5개 (매출·영업이익·순이익·FCF·주식수·부채·현금). 호출 1번.
//  - 네이버 (한국 종목만): 공시 기준 영업이익·지배순이익 + 증권사 컨센서스(E). 연간·분기 2번.
//  값은 재무 통화의 원 단위 그대로 저장한다. 기간 키는 결산 월 "YYYY.MM".
//  KV fin:<심볼> 에 받은 기간을 계속 쌓는다 → 분기 이력이 시간이 갈수록 길어져 YoY·가속도 칸이 채워진다.
//  KV fin:idx = {심볼: 받은 시각} — 크론이 오래된 것부터 고른다.
import { classify, getJson } from "./prices.js";

const STALE_MS = 20 * 3600 * 1000;
const FIN_V = 2; // 저장 형식 버전 — 올리면 예전 저장분은 카드 열 때 새로 받는다 (2: 이자비용·차입금 세부·재무상태 이력)
const KEEP_Q = 28, KEEP_A = 12;

// 손익·현금흐름 (기간 합) — ie 이자비용, ebitda, ocf 영업현금흐름
const FIELD = {
  TotalRevenue: "rev", OperatingIncome: "oi", NetIncomeCommonStockholders: "ni", FreeCashFlow: "fcf",
  InterestExpense: "ie", EBITDA: "ebitda", OperatingCashFlow: "ocf",
};
// 재무상태 (시점 값) — cd 단기차입금, ltd 장기차입금, eq 자본, ca/cl 유동자산·부채, liab 총부채
const BS = {
  OrdinarySharesNumber: "shares", TotalDebt: "debt", CashCashEquivalentsAndShortTermInvestments: "cash",
  CurrentDebt: "cd", LongTermDebt: "ltd", StockholdersEquity: "eq", CurrentAssets: "ca", CurrentLiabilities: "cl",
  TotalLiabilitiesNetMinorityInterest: "liab",
};
const Y_TYPES = ["annual", "quarterly"].flatMap((p) => [...Object.keys(FIELD), ...Object.keys(BS)].map((t) => p + t));
const FLOWS = Object.values(FIELD);
const BS_F = Object.values(BS);

const keyOf = (d) => `${d.slice(0, 4)}.${d.slice(5, 7)}`;               // 2025-12-31 → 2025.12
const monthIdx = (k) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
const fin = (x) => typeof x === "number" && Number.isFinite(x);
const n0 = (s) => { const t = String(s ?? "").replace(/,/g, "").trim(); if (t === "" || t === "-") return NaN; const n = Number(t); return Number.isFinite(n) ? n : NaN; };

// ---------- Yahoo ----------
async function fetchYahoo(sym, budget) {
  const p2 = Math.floor(Date.now() / 1000) + 86400;
  const p1 = p2 - 86400 * 365 * 12;
  const j = await getJson(`https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(sym)}?type=${Y_TYPES.join(",")}&period1=${p1}&period2=${p2}`, budget);
  const A = {}, Q = {}, bsA = {}, bsQ = {};
  let ccy = null;
  for (const r of j.timeseries?.result || []) {
    const type = r.meta?.type?.[0];
    if (!type) continue;
    const m = type.match(/^(annual|quarterly)(.+)$/);
    if (!m) continue;
    const per = m[1], name = m[2];
    for (const x of r[type] || []) {
      if (!x || !x.asOfDate || !fin(x.reportedValue?.raw)) continue;
      const k = keyOf(x.asOfDate);
      if (FIELD[name]) {
        if (!ccy && x.currencyCode) ccy = x.currencyCode;
        const T = per === "annual" ? A : Q;
        (T[k] ||= { k, end: x.asOfDate })[FIELD[name]] = x.reportedValue.raw;
      } else if (BS[name]) {
        const T = per === "annual" ? bsA : bsQ;
        (T[k] ||= { k })[BS[name]] = x.reportedValue.raw;
        if (name !== "OrdinarySharesNumber" && !ccy && x.currencyCode) ccy = x.currencyCode;
      }
    }
  }
  // 재무상태: 가장 최근 분기 → 없으면 연간
  const latest = (T) => Object.values(T).sort((a, b) => (a.k < b.k ? 1 : -1));
  const bs = {};
  for (const f of BS_F) {
    const hit = latest(bsQ).find((r) => fin(r[f])) || latest(bsA).find((r) => fin(r[f]));
    if (hit) { bs[f] = hit[f]; bs[f + "_k"] = hit.k; }
  }
  return { ccy, annual: Object.values(A), quarterly: Object.values(Q), bs, bsA: Object.values(bsA), bsQ: Object.values(bsQ) };
}

// ---------- 네이버 (한국) ----------
async function fetchNaverKr(code, period, budget) {
  const j = await getJson(`https://m.stock.naver.com/api/stock/${code}/finance/${period}`, budget);
  const f = j.financeInfo;
  if (!f) return { actual: [], cons: [] };
  const rows = f.rowList || [];
  const col = (title) => rows.find((r) => r.title === title)?.columns || {};
  const rev = col("매출액"), oi = col("영업이익"), ni = col("지배주주순이익"), niAll = col("당기순이익"), eps = col("EPS"), per = col("PER");
  const actual = [], cons = [];
  for (const t of f.trTitleList || []) {
    const key = t.key; // 202512
    const k = `${key.slice(0, 4)}.${key.slice(4, 6)}`;
    const v = (c) => n0(c[key]?.value) * 1e8; // 억원 → 원
    let niV = v(ni);
    if (!fin(niV)) niV = v(niAll);
    const rec = { k, rev: v(rev), oi: v(oi), ni: niV, src: "naver" };
    if (t.isConsensus === "Y") cons.push({ ...rec, eps: n0(eps[key]?.value), per: n0(per[key]?.value) });
    else actual.push(rec);
  }
  const clean = (r) => Object.fromEntries(Object.entries(r).filter(([, x]) => !(typeof x === "number" && Number.isNaN(x))));
  return { actual: actual.map(clean), cons: cons.map(clean).filter((r) => fin(r.rev) || fin(r.oi) || fin(r.ni)) };
}

// ---------- 합치기 ----------
function mergePeriods(oldList, newList) {
  const m = new Map((oldList || []).filter((r) => !r.d).map((r) => [r.k, r])); // 계산으로 채운 분기는 매번 다시 계산
  for (const r of newList) m.set(r.k, { ...(m.get(r.k) || {}), ...r });
  return [...m.values()].sort((a, b) => (a.k < b.k ? -1 : 1));
}

/** 연간 실적 − 같은 해 분기 3개 = 빠진 분기 하나 (매출·영업이익·순이익·FCF) */
function deriveQuarters(annual, quarterly) {
  const byIdx = new Map(quarterly.map((q) => [monthIdx(q.k), q]));
  const near = (i) => byIdx.get(i) || byIdx.get(i - 1) || byIdx.get(i + 1);
  const add = [];
  for (const a of annual) {
    const end = monthIdx(a.k);
    const slots = [end, end - 3, end - 6, end - 9].map((i) => ({ i, q: near(i) }));
    const missing = slots.filter((s) => !s.q);
    if (missing.length !== 1) continue;
    const i = missing[0].i;
    const rec = { k: `${Math.floor(i / 12)}.${String((i % 12) + 1).padStart(2, "0")}`, d: true, src: "계산" };
    let any = false;
    for (const f of FLOWS) {
      const parts = slots.filter((s) => s.q).map((s) => s.q[f]);
      if (fin(a[f]) && parts.every(fin)) { rec[f] = a[f] - parts.reduce((x, y) => x + y, 0); any = true; }
    }
    if (any) add.push(rec);
  }
  return [...quarterly, ...add].sort((a, b) => (a.k < b.k ? -1 : 1));
}

/** 바깥에서 받아 와서 이전 기록과 합친다. budget 은 한국 3, 그 외 1 필요. */
export async function fetchFundamentals(sym, old, budget) {
  const c = classify(sym);
  const tasks = [fetchYahoo(sym, budget).catch((e) => ({ err: String(e.message || e) }))];
  if (c.kind === "kr") {
    tasks.push(fetchNaverKr(c.code, "annual", budget).catch(() => null));
    tasks.push(fetchNaverKr(c.code, "quarter", budget).catch(() => null));
  }
  const [y, na, nq] = await Promise.all(tasks);
  const yOk = y && !y.err;
  if (!yOk && !na && !nq) throw new Error(y?.err || "재무 데이터 없음");

  const tag = (list, src) => list.map((r) => ({ ...r, src }));
  let annual = yOk ? tag(y.annual, "yahoo") : [];
  let quarterly = yOk ? tag(y.quarterly, "yahoo") : [];
  // 한국: 겹치는 기간은 네이버(공시 기준 영업이익·지배순이익) 우선, FCF 는 Yahoo 에만 있음
  const overlay = (base, nav) => {
    const m = new Map(base.map((r) => [r.k, r]));
    for (const r of nav) m.set(r.k, { ...(m.get(r.k) || { k: r.k }), ...r, fcf: m.get(r.k)?.fcf });
    return [...m.values()];
  };
  if (na) annual = overlay(annual, na.actual);
  if (nq) quarterly = overlay(quarterly, nq.actual);

  const A = mergePeriods(old?.annual, annual).slice(-KEEP_A);
  const Q = deriveQuarters(A, mergePeriods(old?.quarterly, quarterly)).slice(-KEEP_Q);
  return {
    sym, at: Date.now(),
    ccy: (yOk && y.ccy) || old?.ccy || (c.kind === "kr" ? "KRW" : null),
    annual: A, quarterly: Q,
    cons: { annual: na?.cons || old?.cons?.annual || [], quarterly: nq?.cons || old?.cons?.quarterly || [] },
    bs: yOk && Object.keys(y.bs).length ? y.bs : old?.bs || {},
    // 재무상태 이력 (차입금·현금 추이) — 받을 때마다 쌓는다
    bsHist: {
      annual: mergePeriods(old?.bsHist?.annual, yOk ? y.bsA : []).slice(-KEEP_A),
      quarterly: mergePeriods(old?.bsHist?.quarterly, yOk ? y.bsQ : []).slice(-KEEP_Q),
    },
    v: FIN_V,
    warn: yOk ? null : `Yahoo 실패: ${String(y?.err).slice(0, 120)}`,
  };
}

async function save(env, sym, data) {
  await env.KV.put(`fin:${sym}`, JSON.stringify(data));
  const idx = (await env.KV.get("fin:idx", "json")) || {};
  idx[sym] = data.at; idx[sym + "#v"] = FIN_V;
  await env.KV.put("fin:idx", JSON.stringify(idx));
}

/** 카드 열 때: 저장분이 20시간 안이면 그대로, 아니면 새로 받는다 (실패하면 저장분). */
export async function getFundamentals(env, sym, { force = false, budget } = {}) {
  const old = await env.KV.get(`fin:${sym}`, "json");
  if (old && !force && old.v === FIN_V && Date.now() - old.at < STALE_MS) return old;
  try {
    const data = await fetchFundamentals(sym, old, budget);
    await save(env, sym, data);
    return data;
  } catch (e) {
    if (old) return { ...old, warn: `새로 받기 실패 — 저장된 값 표시 (${String(e.message || e).slice(0, 100)})` };
    throw e;
  }
}

/** 크론: 오래된 종목부터 max 개 (남은 호출이 넉넉할 때만) */
export async function refreshFundamentals(env, syms, budget, max = 3) {
  const idx = (await env.KV.get("fin:idx", "json")) || {};
  const now = Date.now();
  const due = syms.filter((s) => now - (idx[s] || 0) > STALE_MS || idx[s + "#v"] !== FIN_V).sort((a, b) => (idx[a] || 0) - (idx[b] || 0));
  let done = 0;
  for (const s of due) {
    if (done >= max || budget.left < 6) break;
    try {
      const old = await env.KV.get(`fin:${s}`, "json");
      const data = await fetchFundamentals(s, old, budget);
      await env.KV.put(`fin:${s}`, JSON.stringify(data));
      idx[s] = data.at; idx[s + "#v"] = FIN_V;
      done++;
    } catch { idx[s] = now - STALE_MS + 3600 * 1000; } // 실패 → 1시간 뒤 다시
  }
  if (due.length) await env.KV.put("fin:idx", JSON.stringify(idx));
  return `재무 ${done}/${due.length}`;
}
