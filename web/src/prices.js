// 시세 출처: 한국·미국·일본 = 네이버(여러 종목 한 번에), 유럽 등 = Yahoo, 실패 시 서로 대체.
// 심볼 표기는 시트 ticker_map 의 yfinance 심볼을 그대로 쓴다 (005930.KS, AAPL, 8725.T, AIXA.DE ...).
// 무료 플랜은 요청 1번에 바깥 호출 50개까지라 budget 으로 호출 수를 센다.

const UA = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };
const num = (s) => { const n = Number(String(s ?? "").replace(/,/g, "")); return Number.isFinite(n) && n > 0 ? n : NaN; };

export class Budget {
  constructor(n) { this.left = n; }
  take() { if (this.left <= 0) throw new Error("바깥 호출 한도 소진"); this.left--; }
}

export async function getJson(url, budget) {
  budget.take();
  const r = await fetch(url, { headers: UA });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 80)}: ${t.slice(0, 120)}`);
  return JSON.parse(t);
}

/** 심볼 분류: kr(국내 6자리) / world(네이버 해외: 미국·일본) / yahoo(그 외) */
export function classify(sym) {
  const m = sym.match(/^(\d{6})\.(KS|KQ)$/);
  if (m) return { kind: "kr", code: m[1] };
  if (/^\d{4}\.T$/.test(sym)) return { kind: "world", cands: [sym] };
  if (/^[A-Z][A-Z0-9]{0,5}$/.test(sym)) return { kind: "world", cands: [`${sym}.O`, sym, `${sym}.K`, `${sym}.N`, `${sym}.A`] };
  return { kind: "yahoo" };
}

/** 네이버 해외 코드 찾기 (AROC → AROC.K 처럼 거래소마다 다름). 못 찾으면 "" */
export async function resolveNaverCode(sym, budget) {
  for (const c of classify(sym).cands || []) {
    try {
      const j = await getJson(`https://api.stock.naver.com/stock/${encodeURIComponent(c)}/basic`, budget);
      if (j && j.reutersCode) return j.reutersCode;
    } catch (e) { if (String(e).includes("한도")) throw e; }
  }
  return "";
}

// ---------- 현재가 ----------
const kstDate = (iso) => (iso ? String(iso).slice(0, 10) : null); // localTradedAt 은 현지 시각 ISO

async function naverMulti(kind, codes, budget) {
  const out = {};
  for (let i = 0; i < codes.length; i += 40) {
    const chunk = codes.slice(i, i + 40);
    const j = await getJson(`https://polling.finance.naver.com/api/realtime/${kind}/stock/${chunk.join(",")}`, budget);
    for (const d of j.datas || []) {
      const key = kind === "domestic" ? d.itemCode : d.reutersCode;
      const p = num(d.closePrice);
      if (key && !Number.isNaN(p)) out[key] = { p, d: kstDate(d.localTradedAt), src: "naver" };
    }
  }
  return out;
}


// Yahoo 타임스탬프 → 거래소 현지 날짜. 서머타임 때문에 meta.gmtoffset(현재 시차) 하나로는 틀린다
// (여름 런던 자정 = 전날 23:00 UTC). yfinance 처럼 거래소 시간대로 날짜를 매긴다.
const dtf = new Map();
function localDate(ts, tz) {
  if (!tz) return new Date(ts * 1000).toISOString().slice(0, 10);
  if (!dtf.has(tz)) dtf.set(tz, new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }));
  return dtf.get(tz).format(new Date(ts * 1000));
}

async function yahooQuote(sym, budget) {
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`, budget);
  const m = j.chart.result[0].meta;
  const p = Number(m.regularMarketPrice);
  if (!(p > 0)) throw new Error(`Yahoo 가격 없음 ${sym}`);
  const d = localDate(m.regularMarketTime, m.exchangeTimezoneName);
  return { p, d, src: "yahoo" };
}

/**
 * symbols: yfinance 심볼 목록, codes: {심볼: 네이버 해외코드|""}
 * → {심볼: {p, d, src}} (실패한 심볼은 빠짐)
 */
export async function fetchCurrent(symbols, codes, budget) {
  const out = {};
  const kr = {}, world = {}, yahoo = [];
  for (const s of symbols) {
    const c = classify(s);
    if (c.kind === "kr") kr[c.code] = s;
    else if (c.kind === "world" && codes[s]) world[codes[s]] = s;
    else yahoo.push(s);
  }
  const tasks = [];
  if (Object.keys(kr).length) tasks.push(naverMulti("domestic", Object.keys(kr), budget).then((r) => { for (const [k, v] of Object.entries(r)) out[kr[k]] = v; }).catch(() => {}));
  if (Object.keys(world).length) tasks.push(naverMulti("worldstock", Object.keys(world), budget).then((r) => { for (const [k, v] of Object.entries(r)) out[world[k]] = v; }).catch(() => {}));
  await Promise.all(tasks);
  // 네이버에서 빠진 것 + 원래 Yahoo 대상 → Yahoo
  const rest = symbols.filter((s) => !out[s]);
  await Promise.all(rest.map((s) => yahooQuote(s, budget).then((v) => { out[s] = v; }).catch(() => {})));
  return out;
}

const FX_YAHOO = { USD: "USDKRW=X", EUR: "EURKRW=X", JPY: "JPYKRW=X" };

/** 환율 → {USD:{p,d,src}, EUR, JPY}  (JPY 는 1엔당)
 *  Yahoo 우선: 새벽 자동 스냅샷(파이썬 yfinance)·환율 이력과 기준을 맞추기 위해. 네이버(하나은행 고시)는 예비. */
export async function fetchFx(budget) {
  const out = {};
  await Promise.all(Object.keys(FX_YAHOO).map(async (ccy) => {
    try { out[ccy] = await yahooQuote(FX_YAHOO[ccy], budget); return; } catch { /* 네이버로 */ }
    try {
      const j = await getJson(`https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_${ccy}KRW`, budget);
      let p = num(j.result?.closePrice);
      if (ccy === "JPY") p = p / 100; // 네이버는 100엔당
      if (!Number.isNaN(p)) out[ccy] = { p, d: kstDate(j.result?.localTradedAt), src: "naver" };
    } catch { /* 없음 → DEFAULT_FX */ }
  }));
  return out;
}

// ---------- 일별 이력 ----------
const ymd = (d) => d.replace(/-/g, "");

/** → [[YYYY-MM-DD, close], ...] 오름차순 */
export async function fetchHistory(sym, start, end, budget) {
  const c = classify(sym);
  if (c.kind === "kr") {
    try {
      const j = await getJson(`https://api.stock.naver.com/chart/domestic/item/${c.code}/day?startDateTime=${ymd(start)}0000&endDateTime=${ymd(end)}2359`, budget);
      const s = (j || []).filter((r) => r.closePrice > 0)
        .map((r) => [`${r.localDate.slice(0, 4)}-${r.localDate.slice(4, 6)}-${r.localDate.slice(6, 8)}`, Number(r.closePrice)]);
      if (s.length) return s;
    } catch { /* Yahoo 로 */ }
  }
  return yahooHistory(sym, start, end, budget);
}

export async function yahooHistory(sym, start, end, budget) {
  const p1 = Math.floor(Date.parse(start + "T00:00:00Z") / 1000) - 86400;
  const p2 = Math.floor(Date.parse(end + "T00:00:00Z") / 1000) + 2 * 86400;
  const j = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=history`, budget);
  const r = j.chart.result?.[0];
  if (!r || !r.timestamp) return [];
  const tz = r.meta?.exchangeTimezoneName;
  const close = r.indicators.quote[0].close;
  const m = new Map();
  r.timestamp.forEach((ts, i) => {
    const v = close[i];
    if (v == null || !(v > 0)) return;
    const d = localDate(ts, tz);
    if (d >= start && d <= end) m.set(d, v);
  });
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export const fxSymbol = (ccy) => FX_YAHOO[ccy];

/** 이력 끝에 현재가를 붙인다 (같은 날이면 교체) — yfinance 이력에 오늘 장중가가 들어가는 것과 같은 효과. */
export function withLatest(series, cur) {
  if (!cur || !cur.d || !(cur.p > 0)) return series || [];
  const s = (series || []).slice();
  if (s.length && s[s.length - 1][0] === cur.d) s[s.length - 1] = [cur.d, cur.p];
  else if (!s.length || s[s.length - 1][0] < cur.d) s.push([cur.d, cur.p]);
  return s;
}
