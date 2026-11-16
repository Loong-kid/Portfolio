// 기술적 분석 (종목 분석 카드 안 탭): 추세 판정 · 모멘텀 · 진입과 손절선.
// 일봉은 /api/valuation/ta 에서 받고, 지표 계산은 전부 여기서 한다 (입력하는 대로 바로 바뀌게).
// 설정은 종목 분석 입력(inp)에 같이 담겨 시트 valuation 탭에 저장된다.
import { esc, isNum, fmt, api, store } from "./util.js";
import { lineChart } from "./charts.js";

// ---------- 지표 ----------
function sma(a, n) {
  const out = new Array(a.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= n) s -= a[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function ema(a, n) {
  const out = new Array(a.length).fill(NaN), k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < a.length; i++) {
    if (!isNum(a[i])) continue;
    prev = isNum(prev) ? a[i] * k + prev * (1 - k) : a[i];
    out[i] = prev;
  }
  return out;
}
/** 와일더 평균 (RSI·ATR): 처음 n 개 단순평균 후 (prev·(n−1) + x)/n */
function rma(a, n) {
  const out = new Array(a.length).fill(NaN);
  let s = 0, cnt = 0, prev = NaN;
  for (let i = 0; i < a.length; i++) {
    if (!isNum(a[i])) continue;
    if (!isNum(prev)) { s += a[i]; cnt++; if (cnt === n) { prev = s / n; out[i] = prev; } }
    else { prev = (prev * (n - 1) + a[i]) / n; out[i] = prev; }
  }
  return out;
}
function atr(h, l, c, n = 14) {
  const tr = c.map((_, i) => (i === 0 ? h[0] - l[0] : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
  return rma(tr, n);
}
function rsi(c, n = 14) {
  const up = c.map((x, i) => (i === 0 ? NaN : Math.max(0, x - c[i - 1])));
  const dn = c.map((x, i) => (i === 0 ? NaN : Math.max(0, c[i - 1] - x)));
  const au = rma(up, n), ad = rma(dn, n);
  return au.map((u, i) => (isNum(u) && isNum(ad[i]) ? (ad[i] === 0 ? 100 : 100 - 100 / (1 + u / ad[i])) : NaN));
}
function macd(c) {
  const e12 = ema(c, 12), e26 = ema(c, 26);
  const line = c.map((_, i) => (i >= 25 ? e12[i] - e26[i] : NaN));
  const sig = ema(line, 9);
  return { line, sig, hist: line.map((x, i) => x - sig[i]) };
}

// ---------- 설정 ----------
export const STOP_METHODS = [
  ["ATR", "ATR 트레일링"],
  ["이평", "이동평균 이탈"],
  ["저점", "N일 저점 이탈"],
  ["비율", "진입가 대비 %"],
  ["가격", "직접 가격"],
];
const posInt = (v, d, lo = 2, hi = 400) => (isNum(v) && v >= lo && v <= hi ? Math.round(v) : d);
function settings(inp) {
  const 단기 = posInt(inp.TA_단기, 50), 장기 = posInt(inp.TA_장기, 200);
  return {
    단기, 장기: 장기 > 단기 ? 장기 : Math.max(단기 * 2, 200),
    방식: STOP_METHODS.some(([k]) => k === inp.손절_방식) ? inp.손절_방식 : "ATR",
    atrK: isNum(inp.손절_ATR배수) && inp.손절_ATR배수 > 0 ? inp.손절_ATR배수 : 3,
    이평: posInt(inp.손절_이평, 단기),
    여유: isNum(inp.손절_여유) ? inp.손절_여유 / 100 : 0,
    저점일: posInt(inp.손절_저점일, 20, 2, 250),
    비율: isNum(inp.손절_비율) && inp.손절_비율 > 0 ? inp.손절_비율 / 100 : 0.08,
    가격: isNum(inp.손절_가격) && inp.손절_가격 > 0 ? inp.손절_가격 : NaN,
  };
}

// ---------- 분석 ----------
/** 거래정지일 빼기: 거래량 0 이고 시고저종이 전날 종가와 같은 날 (마지막 봉 = 현재가 반영분은 둠) */
export function cleanBars(bars) {
  const out = [];
  let dropped = 0;
  bars.forEach((b, i) => {
    const prev = out[out.length - 1];
    const flat = prev && i < bars.length - 1 && !b[5] && b[1] === b[4] && b[2] === b[4] && b[3] === b[4] && b[4] === prev[4];
    if (flat) dropped++; else out.push(b);
  });
  return { bars: out, dropped };
}

export function analyze(bars, inp, item) {
  const S = settings(inp);
  const d = bars.map((b) => b[0]), h = bars.map((b) => b[2]), l = bars.map((b) => b[3]), c = bars.map((b) => b[4]);
  const n = c.length, L = n - 1;
  const sS = sma(c, S.단기), sL = sma(c, S.장기), a14 = atr(h, l, c, 14), r14 = rsi(c, 14), M = macd(c);

  // 국면: 단기이평 > 장기이평 = 상승 국면. 바뀐 날 = 골든/데드 크로스
  const regime = sS.map((x, i) => (isNum(x) && isNum(sL[i]) ? (x > sL[i] ? 1 : -1) : 0));
  const crosses = [];
  for (let i = 1; i < n; i++) if (regime[i] && regime[i - 1] && regime[i] !== regime[i - 1]) crosses.push({ i, dir: regime[i] });
  const lastCross = crosses[crosses.length - 1] || null;
  const lastGolden = [...crosses].reverse().find((x) => x.dir === 1) || null;

  // 추세 판정
  const ok = isNum(sL[L]);
  const chk = ok ? {
    cS: c[L] > sS[L], cL: c[L] > sL[L], sl: sS[L] > sL[L],
    slope: isNum(sL[L - 20]) ? sL[L] > sL[L - 20] : null,
  } : null;
  let verdict = null;
  if (chk) {
    const key = chk.sl ? (chk.cS ? "up" : "up-pull") : (chk.cS ? "down-bounce" : "down");
    const title = { up: "상승 추세", "up-pull": "상승 추세 · 조정 중", down: "하락 추세", "down-bounce": "하락 추세 · 반등 중" }[key];
    const strong = key === "up" && chk.cL && chk.slope;
    verdict = { key, title: strong ? "강한 상승 추세" : title, dir: chk.sl ? 1 : -1 };
  }

  // 모멘텀
  const ret = (k) => (L - k >= 0 ? c[L] / c[L - k] - 1 : NaN);
  const retAt = (a, b) => (L - b >= 0 ? c[L - a] / c[L - b] - 1 : NaN); // a일 전 ÷ b일 전
  const hi52 = Math.max(...h.slice(Math.max(0, n - 252))), lo52 = Math.min(...l.slice(Math.max(0, n - 252)));
  const mom = {
    r1: ret(21), r3: ret(63), r6: ret(126), r12: ret(252),
    r12_1: retAt(21, 252), accel: isNum(ret(63)) && isNum(retAt(63, 126)) ? ret(63) - retAt(63, 126) : NaN,
    rsi: r14[L], macd: M.line[L], sig: M.sig[L], hist: M.hist[L], histPrev: M.hist[L - 1],
    hi52, lo52, fromHi: c[L] / hi52 - 1, fromLo: c[L] / lo52 - 1,
  };
  mom.score = [mom.r1, mom.r3, mom.r6, mom.r12].filter(isNum);
  mom.pos = mom.score.filter((x) => x > 0).length;

  // 진입: 직접 넣은 날짜 → (보유 예정이면 "지금 산다면") → 최근 골든크로스 → 6개월 전
  const own = item.구분 === "보유" && isNum(item.평균단가) && item.평균단가 > 0;
  const dateSet = /^\d{4}-\d{2}-\d{2}$/.test(inp.진입일 || "");
  const planned = item.구분 !== "보유" && !dateSet; // 아직 안 산 종목: 지금 기준 손절선
  let ei = -1, eSrc = "";
  if (dateSet) { ei = d.findIndex((x) => x >= inp.진입일); eSrc = "직접 입력"; }
  if (ei < 0 && planned) { ei = L; eSrc = "보유 예정 — 지금 산다고 보고"; }
  if (ei < 0 && lastGolden) { ei = lastGolden.i; eSrc = "최근 골든크로스"; }
  if (ei < 0) { ei = Math.max(0, n - 126); eSrc = "진입 신호 없음 — 6개월 전부터"; }
  const hope = isNum(inp.매수_희망가) && inp.매수_희망가 > 0 ? inp.매수_희망가 : NaN;
  const [ePrice, ePriceSrc] = isNum(inp.진입가) && inp.진입가 > 0 ? [inp.진입가, "직접 입력"]
    : own ? [item.평균단가, "보유 평균단가"]
    : isNum(hope) ? [hope, "매수 희망가"]
    : planned ? [c[L], "현재가"]
    : [c[ei], "진입일 종가"];

  // 손절선 (방식별, 진입일부터)
  const blank = () => new Array(n).fill(NaN);
  const stops = {};
  { const s = blank(); let hh = -Infinity, prev = -Infinity;
    for (let i = ei; i < n; i++) { hh = Math.max(hh, h[i]); if (isNum(a14[i])) { prev = Math.max(prev, hh - S.atrK * a14[i]); s[i] = prev; } }
    stops.ATR = s; }
  { const ma = S.이평 === S.단기 ? sS : S.이평 === S.장기 ? sL : sma(c, S.이평); const s = blank();
    for (let i = ei; i < n; i++) s[i] = ma[i] * (1 - S.여유);
    stops.이평 = s; }
  { const s = blank();
    for (let i = Math.max(ei, S.저점일); i < n; i++) { let m = Infinity; for (let j = i - S.저점일; j < i; j++) m = Math.min(m, l[j]); s[i] = m; }
    stops.저점 = s; }
  { const s = blank(); for (let i = ei; i < n; i++) s[i] = ePrice * (1 - S.비율); stops.비율 = s; }
  { const s = blank(); if (isNum(S.가격)) for (let i = ei; i < n; i++) s[i] = S.가격; stops.가격 = s; }
  if (planned) {
    // 지금 진입가(희망가)에 산다면: ATR 은 진입가 − k×ATR, 나머지는 지금 값. 차트엔 최근 1개월만 수평선으로
    const now = { ATR: ePrice - S.atrK * a14[L], 이평: stops.이평[L], 저점: stops.저점[L], 비율: ePrice * (1 - S.비율), 가격: S.가격 };
    for (const k of Object.keys(stops)) { const s = blank(); if (isNum(now[k])) for (let i = Math.max(0, n - 21); i < n; i++) s[i] = now[k]; stops[k] = s; }
  }
  const sel = stops[S.방식];
  const stopNow = sel[L];
  // 진입 뒤 종가가 손절선 아래로 처음 내려간 날들 (보유 예정은 아직 진입 전이라 없음)
  const breaks = [];
  if (!planned) for (let i = ei + 1; i < n; i++) if (isNum(sel[i]) && isNum(sel[i - 1]) && c[i] < sel[i] && c[i - 1] >= sel[i - 1]) breaks.push(i);

  return { S, d, h, l, c, n, L, sS, sL, a14, r14, M, regime, crosses, lastCross, lastGolden, chk, verdict, mom, ei, eSrc, ePrice, ePriceSrc, own, planned, hope, stops, sel, stopNow, breaks };
}

// ---------- 화면 ----------
const pct = (v, dg = 1) => (isNum(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(dg)}%` : "-");
const cls = (v) => (isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");
const showIn = (v) => (isNum(v) ? v.toLocaleString("ko-KR", { maximumFractionDigits: 4 }) : "");
const parseIn = (s) => { const t = String(s ?? "").replace(/[,\s%]/g, ""); if (t === "") return null; const x = Number(t); return Number.isFinite(x) ? x : NaN; };
const RANGES = [["6M", "6개월", 126], ["1Y", "1년", 252], ["2Y", "2년", 504], ["3Y", "3년", 800]];
const T = { range: store.get("taRange", "1Y"), sub: store.get("taSub", "RSI") };

/**
 * pane: 그릴 곳, card: 종목 분석 카드 데이터, inp: 입력(공유), hooks: {dirty(), saveBtn(html)}
 */
export async function renderTech(pane, card, inp, hooks) {
  const item = card.item;
  pane.innerHTML = `<div class="skeleton">일봉 불러오는 중…</div>`;
  let ta;
  try { ta = await api(`/api/valuation/ta?name=${encodeURIComponent(item.종목)}`); }
  catch (e) { pane.innerHTML = `<div class="notice err">일봉을 못 받았어요: ${esc(e.message)}</div>`; return; }
  if (!ta.bars || ta.bars.length < 30) { pane.innerHTML = `<div class="notice warn">일봉 데이터가 너무 적어요 (${ta.bars?.length || 0}일).</div>`; return; }
  const { bars, dropped } = cleanBars(ta.bars);
  const ccy = item.통화;
  const P = (x) => fmt.price(x, ccy);
  const A0 = analyze(bars, inp, item);

  const field = (f, label, ph, w = "") => `<label class="field ${w}"><span>${label}</span><input class="num" data-t="${f}" inputmode="decimal" value="${esc(showIn(inp[f]))}" placeholder="${esc(ph)}"></label>`;
  pane.innerHTML = `
    ${ta.warn ? `<div class="notice warn">${esc(ta.warn)}</div>` : ""}
    ${dropped ? `<div class="notice warn">거래가 없던 날(거래정지 등) ${dropped}일은 이동평균·ATR·수익률 계산에서 뺐어요.</div>` : ""}
    <div id="taTop"></div>
    <div class="section">
      <div class="ta-head">
        <h2 style="margin:0">가격과 추세 <span class="sub">음영 = 국면 (빨강 상승 · 파랑 하락) · 점선 = 내 손절선</span></h2>
        <div class="seg" id="taRange">${RANGES.map(([k, lb]) => `<button data-r="${k}" aria-pressed="${T.range === k}">${lb}</button>`).join("")}</div>
      </div>
      <div class="card"><div id="taPx"></div></div>
      <div class="ta-head" style="margin-top:14px">
        <h2 style="margin:0;font-size:15px">모멘텀</h2>
        <div class="seg" id="taSub">${[["RSI", "RSI (14)"], ["ROC", "3개월 수익률"], ["MACD", "MACD"]].map(([k, lb]) => `<button data-s="${k}" aria-pressed="${T.sub === k}">${lb}</button>`).join("")}</div>
      </div>
      <div class="card"><div id="taSubChart"></div></div>
    </div>
    <div class="section">
      <h2>진입과 손절선 <span class="sub">상승 추세에 들어갔을 때 어디서 "추세가 꺾였다"고 볼지 정해 두는 칸</span></h2>
      <div class="card ta-form">
        <div class="form-grid">
          <label class="field"><span>진입일 <small>비우면 자동</small></span><input type="date" data-t="진입일" value="${esc(inp.진입일 || "")}"></label>
          ${field("진입가", `진입가 <small>${esc(ccy)}</small>`, `${P(A0.ePrice)} (${A0.ePriceSrc})`)}
          ${field("TA_단기", "단기 이평 (일)", "50")}
          ${field("TA_장기", "장기 이평 (일)", "200")}
        </div>
        <p class="caption" id="taEntryNote"></p>
        <div class="table-wrap flat edit" style="margin-top:10px"><table class="data ta-stops">
          <thead><tr><th class="l">손절 방식</th><th class="l">설정</th><th>지금 손절선</th><th>현재가 대비</th></tr></thead>
          <tbody>
            ${STOP_METHODS.map(([k, lb]) => `<tr data-m="${k}">
              <td class="l"><label class="toggle"><input type="radio" name="taStop" value="${k}" ${A0.S.방식 === k ? "checked" : ""}> ${lb}</label></td>
              <td class="l set">${{
                ATR: `최고가 − <input class="num sm" data-t="손절_ATR배수" inputmode="decimal" value="${esc(showIn(inp.손절_ATR배수))}" placeholder="3"> × ATR(14)`,
                이평: `<input class="num sm" data-t="손절_이평" inputmode="numeric" value="${esc(showIn(inp.손절_이평))}" placeholder="단기"> 일선 − <input class="num sm" data-t="손절_여유" inputmode="decimal" value="${esc(showIn(inp.손절_여유))}" placeholder="0"> %`,
                저점: `최근 <input class="num sm" data-t="손절_저점일" inputmode="numeric" value="${esc(showIn(inp.손절_저점일))}" placeholder="20"> 일 저가`,
                비율: `진입가 − <input class="num sm" data-t="손절_비율" inputmode="decimal" value="${esc(showIn(inp.손절_비율))}" placeholder="8"> %`,
                가격: `<input class="num" data-t="손절_가격" inputmode="decimal" value="${esc(showIn(inp.손절_가격))}" placeholder="${esc(ccy)}" style="width:110px">`,
              }[k]}</td>
              <td class="v-now"></td><td class="v-dist"></td></tr>`).join("")}
          </tbody>
        </table></div>
        <div id="taStopSum" class="ta-sum"></div>
        ${hooks.saveBtn()}
      </div>
      <p class="caption">ATR 트레일링은 진입 뒤 최고가에서 평소 하루 변동폭(ATR)의 몇 배만큼 아래에 선을 두고, 주가가 오르면 따라 올라가요 (내려가지는 않아요). 이동평균 이탈은 종가가 이평선 아래로 내려가면 추세가 꺾였다고 보는 방식이에요.</p>
    </div>`;

  hooks.bind(pane);
  const draw = () => {
    const A = analyze(bars, inp, item);
    drawTop(document.getElementById("taTop"), A, P);
    drawCharts(A, P);
    drawStops(A, P, card);
    const ep = pane.querySelector('[data-t="진입가"]');
    if (ep) ep.placeholder = `${P(A.ePrice)} (${A.ePriceSrc})`;
  };
  draw();
  pane.addEventListener("inp-change", draw); // 머리의 매수 희망가가 바뀌면 진입가 기본값도 바뀜

  pane.querySelector("#taRange").addEventListener("click", (e) => {
    const b = e.target.closest("[data-r]"); if (!b) return;
    T.range = b.dataset.r; store.set("taRange", T.range);
    pane.querySelectorAll("#taRange button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    drawCharts(analyze(bars, inp, item), P);
  });
  pane.querySelector("#taSub").addEventListener("click", (e) => {
    const b = e.target.closest("[data-s]"); if (!b) return;
    T.sub = b.dataset.s; store.set("taSub", T.sub);
    pane.querySelectorAll("#taSub button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    drawCharts(analyze(bars, inp, item), P);
  });
  pane.querySelectorAll("[data-t]").forEach((el) => {
    const f = el.dataset.t, isText = el.type === "date";
    el.addEventListener("input", () => {
      inp[f] = isText ? el.value : parseIn(el.value);
      if (!isText) el.classList.toggle("invalid", Number.isNaN(inp[f]));
      hooks.dirty();
      draw();
    });
    if (!isText) el.addEventListener("blur", () => { if (isNum(inp[f])) el.value = showIn(inp[f]); });
  });
  pane.querySelectorAll('input[name="taStop"]').forEach((el) => el.addEventListener("change", () => { inp.손절_방식 = el.value; hooks.dirty(); draw(); }));
}

function drawTop(box, A, P) {
  const { verdict: V, chk, mom: m, S } = A;
  const since = A.lastCross;
  const sinceTxt = since ? `${since.dir === 1 ? "골든크로스" : "데드크로스"} ${A.d[since.i]} 이후 ${A.L - since.i}거래일 · ${pct(A.c[A.L] / A.c[since.i] - 1)}` : "기간 안에 이평 교차 없음";
  const yes = (b, label, val) => `<li class="${b === null ? "na" : b ? "yes" : "no"}"><span class="mark">${b === null ? "-" : b ? "충족" : "미달"}</span><span>${label}</span><b>${val}</b></li>`;
  const tile = (label, v, sub = "") => `<div class="metric"><div class="label">${label}</div><div class="value ${cls(v)}">${pct(v)}</div>${sub ? `<div class="delta muted">${sub}</div>` : ""}</div>`;
  const rsiTxt = isNum(m.rsi) ? (m.rsi >= 70 ? "과열 구간" : m.rsi <= 30 ? "침체 구간" : m.rsi >= 50 ? "50 위 (매수 우위)" : "50 아래 (매도 우위)") : "";
  const macdUp = isNum(m.macd) && isNum(m.sig) ? m.macd > m.sig : null;
  const histUp = isNum(m.hist) && isNum(m.histPrev) ? m.hist > m.histPrev : null;
  box.innerHTML = `
    <div class="section ta-top">
      <div class="metric hero ta-verdict ${V ? (V.dir > 0 ? "is-up" : "is-down") : ""}">
        <div class="label">지금 추세 · 이평 ${S.단기}/${S.장기}일</div>
        <div class="value">${V ? V.title : "판단 불가"}</div>
        <div class="delta">${V ? esc(sinceTxt) : `장기 이평(${S.장기}일)을 계산할 일봉이 부족해요 (${A.n}일)`}</div>
      </div>
      <div class="card ta-checks">
        <ul>
          ${chk ? `
          ${yes(chk.cS, `종가 > ${S.단기}일선`, `${P(A.sS[A.L])}`)}
          ${yes(chk.cL, `종가 > ${S.장기}일선`, `${P(A.sL[A.L])}`)}
          ${yes(chk.sl, `${S.단기}일선 > ${S.장기}일선`, chk.sl ? "상승 국면" : "하락 국면")}
          ${yes(chk.slope, `${S.장기}일선 오르는 중 (20일 전 대비)`, isNum(A.sL[A.L - 20]) ? pct(A.sL[A.L] / A.sL[A.L - 20] - 1) : "-")}` : `<li class="na"><span class="mark">-</span><span>일봉 ${A.n}일 — 장기 이평을 줄여 보세요</span></li>`}
          ${yes(m.fromHi > -0.25, "52주 고점에서 25% 안쪽", pct(m.fromHi))}
        </ul>
      </div>
    </div>
    <div class="section">
      <h2>모멘텀 <span class="sub">기간 수익률 ${m.pos}/${m.score.length} 플러스 · 12-1개월 = 최근 1개월을 뺀 1년 수익률 (단기 반락 잡음 제거)</span></h2>
      <div class="metrics ta-mom">
        ${tile("1개월", m.r1)}${tile("3개월", m.r3)}${tile("6개월", m.r6)}${tile("12개월", m.r12)}
        ${tile("12-1개월 모멘텀", m.r12_1)}
        <div class="metric"><div class="label">모멘텀 가속도</div><div class="value ${cls(m.accel)}">${isNum(m.accel) ? `${m.accel >= 0 ? "+" : ""}${(m.accel * 100).toFixed(1)}%p` : "-"}</div><div class="delta muted">최근 3개월 − 그 전 3개월</div></div>
        <div class="metric"><div class="label">RSI (14)</div><div class="value">${isNum(m.rsi) ? m.rsi.toFixed(0) : "-"}</div><div class="delta muted">${rsiTxt}</div></div>
        <div class="metric"><div class="label">MACD</div><div class="value ${macdUp === null ? "" : macdUp ? "up" : "down"}" style="font-size:18px">${macdUp === null ? "-" : macdUp ? "시그널 위" : "시그널 아래"}</div><div class="delta muted">${histUp === null ? "" : histUp ? "힘이 세지는 중" : "힘이 약해지는 중"}</div></div>
        <div class="metric"><div class="label">52주 고점 대비</div><div class="value ${cls(m.fromHi)}">${pct(m.fromHi)}</div><div class="delta muted">고 ${P(m.hi52)} · 저 ${P(m.lo52)}</div></div>
      </div>
    </div>`;
}

function drawCharts(A, P) {
  const span = RANGES.find(([k]) => k === T.range)?.[2] || 252;
  const i0 = Math.max(0, A.n - span);
  const pts = (arr) => A.d.slice(i0).map((d, k) => [d, arr[i0 + k]]);
  // 국면 음영: 연속 구간
  const bands = [];
  for (let i = i0; i < A.n; i++) {
    const r = A.regime[i];
    if (!r) continue;
    const last = bands[bands.length - 1];
    if (last && last.r === r && last.end === i - 1) { last.end = i; last.to = A.d[i]; }
    else bands.push({ r, end: i, from: A.d[i], to: A.d[i] });
  }
  const stopName = { ATR: "손절선 (ATR)", 이평: "손절선 (이평)", 저점: "손절선 (저점)", 비율: "손절선 (진입가 %)", 가격: "손절선 (가격)" }[A.S.방식];
  const refs = A.ei >= i0 && isNum(A.ePrice) ? [{ y: A.ePrice, label: `진입가 ${P(A.ePrice)}` }] : [];
  lineChart(document.getElementById("taPx"), {
    series: [
      { name: "종가", color: "var(--series-1)", points: pts(A.c) },
      { name: `${A.S.단기}일선`, color: "var(--cat-2)", points: pts(A.sS), width: 1.5 },
      { name: `${A.S.장기}일선`, color: "var(--cat-3)", points: pts(A.sL), width: 1.5 },
      { name: stopName, color: "var(--text)", points: pts(A.sel), dash: true, step: true, width: 1.5 },
    ],
    markers: A.breaks.length ? { name: "손절선 이탈", color: "var(--down)", points: A.breaks.filter((i) => i >= i0).map((i) => [A.d[i], A.c[i]]) } : undefined,
    bands: bands.map((b) => ({ from: b.from, to: b.to, color: b.r > 0 ? "var(--band-up)" : "var(--band-down)" })),
    refs,
    height: 320,
    yFormat: (v) => P(v), tipFormat: (v) => P(v),
  });
  const sub = document.getElementById("taSubChart");
  if (T.sub === "RSI") {
    lineChart(sub, { series: [{ name: "RSI (14)", color: "var(--series-1)", points: pts(A.r14) }], refs: [{ y: 70, label: "70 과열" }, { y: 30, label: "30 침체" }], yMin: 0, yMax: 100, height: 160, yFormat: (v) => v.toFixed(0), tipFormat: (v) => v.toFixed(1) });
  } else if (T.sub === "ROC") {
    const roc = A.c.map((x, i) => (i >= 63 ? x / A.c[i - 63] - 1 : NaN));
    lineChart(sub, { series: [{ name: "3개월 수익률", color: "var(--series-1)", points: pts(roc), fill: "var(--series-1-fill)" }], includeZero: true, height: 160, yFormat: (v) => `${Math.round(v * 100)}%`, tipFormat: (v) => pct(v) });
  } else {
    lineChart(sub, { series: [{ name: "MACD", color: "var(--series-1)", points: pts(A.M.line) }, { name: "시그널", color: "var(--cat-2)", points: pts(A.M.sig), width: 1.5 }], includeZero: true, height: 160, yFormat: (v) => P(v), tipFormat: (v) => P(v) });
  }
}

function drawStops(A, P, card) {
  const px = A.c[A.L];
  for (const [k] of STOP_METHODS) {
    const tr = document.querySelector(`.ta-stops tr[data-m="${k}"]`);
    if (!tr) continue;
    const v = A.stops[k][A.L];
    tr.classList.toggle("sel", A.S.방식 === k);
    tr.querySelector(".v-now").innerHTML = isNum(v) ? `<b>${P(v)}</b>` : `<span class="muted">-</span>`;
    tr.querySelector(".v-dist").innerHTML = isNum(v) ? `<span class="${v > px ? "up" : ""}">${pct(v / px - 1)}</span>` : "";
  }
  const waitTxt = A.verdict && A.verdict.dir < 0 && A.eSrc !== "직접 입력"
    ? ` · 지금은 하락 국면이라 새 진입 신호가 없어요. ${A.S.단기}일선이 ${A.S.장기}일선을 위로 뚫으면(골든크로스) 상승 추세 진입으로 봐요.` : "";
  document.getElementById("taEntryNote").textContent =
    A.planned
      ? `보유 예정 — 진입가 ${P(A.ePrice)} (${A.ePriceSrc})에 지금 산다고 보고 계산 · 현재가 대비 ${pct(A.ePrice / px - 1)}${waitTxt}`
      : `진입일 ${A.d[A.ei]} (${A.eSrc}) · 진입가 ${P(A.ePrice)} (${A.ePriceSrc}) · 진입 뒤 ${pct(px / A.ePrice - 1)}${waitTxt}`;
  const item = card.item, s = A.stopNow;
  const rate = item.통화 === "KRW" ? 1 : card.fx?.[item.통화];
  const qty = A.own ? item.수량 : NaN;
  const lossKrw = isNum(qty) && isNum(s) && isNum(rate) ? (s - px) * qty * rate : NaN;
  const broken = !A.planned && isNum(s) && px < s;
  const conflict = A.planned && isNum(s) && A.ePrice <= s;
  document.getElementById("taStopSum").innerHTML = !isNum(s)
    ? `<div class="notice warn">이 방식으로는 손절선을 계산할 수 없어요 (값을 넣거나 진입일을 확인해 주세요).</div>`
    : `<div class="ta-sum-row ${broken ? "broken" : ""}">
        <div><div class="label">내 손절선</div><div class="big">${P(s)}</div></div>
        <div><div class="label">현재가 ${P(px)} 대비</div><div class="big ${broken ? "" : "down"}">${pct(s / px - 1)}</div></div>
        <div><div class="label">${A.planned ? `진입가 ${P(A.ePrice)}에 사면 손절까지` : "진입가 대비"}</div><div class="big ${cls(s / A.ePrice - 1)}">${pct(s / A.ePrice - 1)}</div></div>
        ${isNum(lossKrw) && !broken ? `<div><div class="label">손절 시 평가액 변화 (${fmt.qty(qty)}주)</div><div class="big ${cls(lossKrw)}">${fmt.krw(lossKrw)}</div></div>` : ""}
      </div>
      ${broken ? `<div class="notice err" style="margin-top:10px">종가가 손절선 아래에 있어요 — 정해 둔 기준으로는 하락 추세로 꺾인 상태예요.</div>` : ""}
      ${conflict ? `<div class="notice warn" style="margin-top:10px">진입가(${P(A.ePrice)})가 손절선보다 낮거나 같아요 — 그 가격까지 내려오면 이 기준으로는 이미 추세가 꺾인 상태라, 진입 조건과 손절 조건이 부딪혀요. 희망가나 손절 방식을 다시 봐 주세요.</div>` : ""}
      ${A.planned ? `<p class="caption">보유 예정이라 진입가에 지금 산다고 보고 계산했어요. 실제로 사면 진입일을 넣거나, 스냅샷에 들어가는 순간 보유 기준(평균단가·진입 뒤 최고가 추적)으로 바뀌어요.</p>` : ""}
      ${A.breaks.length ? `<p class="caption">진입 뒤 손절선 이탈 ${A.breaks.length}번${A.breaks.length > 6 ? " · 최근 6번" : ""}: ${A.breaks.slice(-6).map((i) => A.d[i]).join(", ")} (차트의 파란 마름모)</p>` : ""}`;
}
