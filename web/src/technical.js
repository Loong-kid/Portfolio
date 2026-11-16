// 기술적 분석용 일봉 (시가·고가·저가·종가·거래량) 3년치.
//  - 한국: 네이버 국내 차트 (실패하면 Yahoo), 그 외: Yahoo chart.
//  - KV ta:<심볼> = {at, bars:[[YYYY-MM-DD, o, h, l, c, v], ...]} — 4시간 지나면 새로 받는다 (카드 열 때만, 크론 X).
//  지표 계산(이동평균·ATR·RSI·MACD·손절선)은 화면 JS(public/js/technical.js)에서 한다.
import { classify, getJson } from "./prices.js";

const STALE_MS = 4 * 3600 * 1000;
const YEARS = 3;

const iso = (d) => d.toISOString().slice(0, 10);
const ymd = (s) => s.replace(/-/g, "");

function localDate(ts, tz) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts * 1000)); }
  catch { return iso(new Date(ts * 1000)); }
}

async function naverBars(code, start, end, budget) {
  const j = await getJson(`https://api.stock.naver.com/chart/domestic/item/${code}/day?startDateTime=${ymd(start)}0000&endDateTime=${ymd(end)}2359`, budget);
  return (j || [])
    .filter((r) => r.closePrice > 0)
    .map((r) => {
      const c = Number(r.closePrice);
      const o = Number(r.openPrice) || c, h = Number(r.highPrice) || c, l = Number(r.lowPrice) || c;
      return [`${r.localDate.slice(0, 4)}-${r.localDate.slice(4, 6)}-${r.localDate.slice(6, 8)}`, o, Math.max(h, c, o), Math.min(l, c, o), c, Number(r.accumulatedTradingVolume) || 0];
    });
}

async function yahooBars(sym, budget) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${YEARS}y&interval=1d`, budget);
  const r = j.chart?.result?.[0];
  if (!r || !r.timestamp) return [];
  const q = r.indicators.quote[0], tz = r.meta?.exchangeTimezoneName;
  const m = new Map();
  r.timestamp.forEach((ts, i) => {
    const c = q.close[i];
    if (c == null || !(c > 0)) return;
    const o = q.open[i] > 0 ? q.open[i] : c, h = q.high[i] > 0 ? q.high[i] : c, l = q.low[i] > 0 ? q.low[i] : c;
    m.set(localDate(ts, tz), [o, Math.max(h, c, o), Math.min(l, c, o), c, q.volume[i] || 0]);
  });
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => [d, ...v]);
}

export async function fetchBars(sym, budget) {
  const c = classify(sym);
  const end = iso(new Date(Date.now() + 9 * 3600 * 1000));
  const start = iso(new Date(Date.now() - YEARS * 365.25 * 864e5));
  if (c.kind === "kr") {
    try { const b = await naverBars(c.code, start, end, budget); if (b.length > 50) return b; } catch { /* Yahoo 로 */ }
  }
  return yahooBars(sym, budget);
}

/** 저장분이 4시간 안이면 그대로, 아니면 새로 받는다 (실패하면 저장분 + warn). */
export async function getBars(env, sym, { force = false, budget } = {}) {
  const old = await env.KV.get(`ta:${sym}`, "json");
  if (old && !force && Date.now() - old.at < STALE_MS) return old;
  try {
    const bars = await fetchBars(sym, budget);
    if (!bars.length) throw new Error("일봉 데이터가 비어 있어요");
    const data = { sym, at: Date.now(), bars };
    await env.KV.put(`ta:${sym}`, JSON.stringify(data));
    return data;
  } catch (e) {
    if (old) return { ...old, warn: `새로 받기 실패 — 저장된 값 표시 (${String(e.message || e).slice(0, 100)})` };
    throw e;
  }
}

/** 마지막 봉에 현재가를 반영 (같은 날이면 종가·고저 갱신, 새 날이면 봉 추가) */
export function withLive(bars, cur) {
  if (!cur || !cur.d || !(cur.p > 0) || !bars.length) return bars;
  const out = bars.slice();
  const last = out[out.length - 1];
  if (last[0] === cur.d) out[out.length - 1] = [last[0], last[1], Math.max(last[2], cur.p), Math.min(last[3], cur.p), cur.p, last[5]];
  else if (last[0] < cur.d) out.push([cur.d, cur.p, cur.p, cur.p, cur.p, 0]);
  return out;
}
