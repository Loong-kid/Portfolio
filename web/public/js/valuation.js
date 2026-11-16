// 종목 분석 (관리자 전용): 재무 실적 + 내 추정 → Forward 지표 · 목표가 · Reverse DCF · 성장률과 가속도.
// 계산은 전부 여기서 한다 (입력하는 대로 바로 바뀌게). 저장은 시트 valuation 탭.
import { esc, isNum, fmt, api, store } from "./util.js";
import { toast } from "./edit.js";
import { renderTech } from "./technical.js";

const V = { name: store.get("valName", null), pane: store.get("valPane", "F") };

// ---------- 숫자 ----------
const unitOf = (ccy) => (ccy === "KRW" ? { div: 1e8, label: "억원" } : { div: 1e6, label: `백만 ${ccy}` });
const mIdx = (k) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
const pos = (x) => isNum(x) && x > 0;
const parseIn = (s) => { const t = String(s ?? "").replace(/[,\s%]/g, ""); if (t === "") return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
const showIn = (v) => (isNum(v) ? v.toLocaleString("ko-KR", { maximumFractionDigits: 4 }) : "");
const roundIn = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toLocaleString("ko-KR");
const mult = (v) => (isNum(v) ? `${v.toFixed(1)}배` : "-");
const pctTxt = (v, d = 1) => (isNum(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%` : "-");
const cls = (v) => (isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");

/** 성장률: 부호가 바뀌면 숫자 대신 말로 */
function growth(a, b) {
  if (!isNum(a) || !isNum(b)) return null;
  if (a > 0 && b > 0) return { v: b / a - 1 };
  if (a > 0 && b <= 0) return { t: "적자전환" };
  if (a <= 0 && b > 0) return { t: "흑자전환" };
  if (a < 0 && b < 0) return { t: Math.abs(b) < Math.abs(a) ? "적자축소" : "적자확대" };
  return null;
}
const gCell = (g) => (!g ? `<span class="muted">-</span>` : isNum(g.v) ? `<span class="${cls(g.v)}">${pctTxt(g.v)}</span>` : `<span class="g-word">${g.t}</span>`);
const accel = (g1, g0) => (g1 && g0 && isNum(g1.v) && isNum(g0.v) ? g1.v - g0.v : null);
const aCell = (a) => (isNum(a) ? `<span class="${cls(a)}">${a > 0 ? "▲" : a < 0 ? "▼" : ""} ${Math.abs(a * 100).toFixed(1)}%p</span>` : `<span class="muted">-</span>`);
const ppCell = (a) => (isNum(a) ? `<span class="${cls(a)}">${a >= 0 ? "+" : ""}${(a * 100).toFixed(1)}%p</span>` : `<span class="muted">-</span>`);

// ---------- Reverse DCF ----------
// 10년간 연 g 성장 + 이후 영구성장 gT. 기준 현금흐름 cf0, 할인율 r. 값 = target 이 되는 g 를 이분법으로.
function pvAt(cf0, g, r, gT, n = 10) {
  let v = 0, cf = cf0;
  for (let t = 1; t <= n; t++) { cf *= 1 + g; v += cf / (1 + r) ** t; }
  return v + (cf * (1 + gT)) / (r - gT) / (1 + r) ** n;
}
function impliedG(cf0, target, r, gT) {
  if (!pos(cf0) || !pos(target) || !(r > gT)) return null;
  let lo = -0.5, hi = 1.5;
  if (pvAt(cf0, lo, r, gT) > target) return { g: lo, edge: "below" };
  if (pvAt(cf0, hi, r, gT) < target) return { g: hi, edge: "above" };
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (pvAt(cf0, mid, r, gT) < target) lo = mid; else hi = mid; }
  return { g: (lo + hi) / 2 };
}

// ---------- 모델 ----------
const N_Q = 8; // 내 추정 분기 수 (2년)
const qKey = (i) => `${Math.floor(i / 12)}.${String((i % 12) + 1).padStart(2, "0")}`;
const near = (list, i) => list.find((x) => x && Math.abs(mIdx(x.k) - i) <= 1) || null;
const sum4 = (qs, f) => (qs.length === 4 && qs.every((r) => r && isNum(r[f])) ? qs.reduce((a, r) => a + r[f], 0) : NaN);

function lastFour(Q) {
  const q = Q.filter((r) => isNum(r.rev) || isNum(r.oi));
  if (q.length < 4) return null;
  const l = q.slice(-4);
  for (let i = 1; i < 4; i++) { const d = mIdx(l[i].k) - mIdx(l[i - 1].k); if (d < 2 || d > 4) return null; }
  const sum = (f) => (l.every((r) => isNum(r[f])) ? l.reduce((a, r) => a + r[f], 0) : NaN);
  return { k: l[3].k, rev: sum("rev"), oi: sum("oi"), ni: sum("ni"), fcf: sum("fcf") };
}

function model(card, inp) {
  const { fin, item, price, fx } = card;
  const ccy = fin.ccy || item.통화;
  const U = unitOf(ccy);
  const rate = (c) => (c === "KRW" ? 1 : fx?.[c]);
  const conv = item.통화 === ccy ? 1 : rate(item.통화) && rate(ccy) ? rate(item.통화) / rate(ccy) : NaN;
  const shares = pos(inp.주식수) ? inp.주식수 : fin.bs?.shares;
  const px = price?.p;
  const mcap = px * conv * shares;
  const hasBs = isNum(fin.bs?.debt) || isNum(fin.bs?.cash);
  const netDebt = hasBs ? (fin.bs.debt || 0) - (fin.bs.cash || 0) : NaN;
  const ev = mcap + (isNum(netDebt) ? netDebt : 0);

  const A = fin.annual.filter((a) => isNum(a.rev) || isNum(a.oi));
  const lastA = A[A.length - 1] || null;
  const fyM = lastA ? lastA.k.slice(5) : "12";
  const baseYear = lastA ? Number(lastA.k.slice(0, 4)) : new Date().getFullYear() - 1;
  const ttm = lastFour(fin.quarterly);
  const cur = ttm ? { ...ttm, label: `최근 4분기 (~${ttm.k})` } : lastA ? { ...lastA, label: `${lastA.k} 연간` } : null;

  // 영업이익 → 순이익 (순이익 칸을 비웠을 때): 최근 연간 실적 비율, 이상하면 0.75
  const r0 = lastA && pos(lastA.ni) && pos(lastA.oi) ? lastA.ni / lastA.oi : NaN;
  const niRatio = isNum(r0) && r0 > 0.2 && r0 < 1.5 ? r0 : 0.75;

  // --- 내 추정: 마지막 실적 분기 다음부터 8개 분기 ---
  const Qact = fin.quarterly.filter((q) => isNum(q.rev) || isNum(q.oi));
  const lastQ = Qact[Qact.length - 1];
  let start = lastQ ? mIdx(lastQ.k) + 3 : NaN;
  if (lastA && !(start >= mIdx(lastA.k) + 3)) start = mIdx(lastA.k) + 3;
  if (!isNum(start)) { const t = new Date(); const i = t.getFullYear() * 12 + t.getMonth(); start = i + ((2 - (i % 3)) + 3) % 3; }
  const fyMi = Number(fyM) - 1;
  const saved = inp.quarters || [];
  const consQ = fin.cons?.quarterly || [];
  const estQ = Array.from({ length: N_Q }, (_, j) => {
    const i = start + 3 * j, k = qKey(i);
    const s = saved.find((x) => x.k === k) || near(saved, i) || {};
    const rev = isNum(s.rev) ? s.rev * U.div : NaN;
    const oi = isNum(s.oi) ? s.oi * U.div : NaN;
    const niIn = isNum(s.ni) ? s.ni * U.div : NaN;
    const ni = isNum(niIn) ? niIn : isNum(oi) ? oi * niRatio : NaN;
    const fq = Math.floor((((i - fyMi - 1) % 12) + 12) % 12 / 3) + 1; // 결산 기준 몇 분기
    return { k, i, fq, savedK: s.k, rev, oi, ni, niAuto: !isNum(niIn) && isNum(oi), filled: isNum(rev) || isNum(oi) || isNum(niIn), cons: near(consQ, i), ly: near(Qact, i - 12) };
  });
  const block = (qs) => {
    const r = { k: qs[3].k, from: qs[0].k, rev: sum4(qs, "rev"), oi: sum4(qs, "oi"), ni: sum4(qs, "ni"), niAuto: qs.some((q) => q.niAuto) };
    r.filled = isNum(r.rev) || isNum(r.oi) || isNum(r.ni);
    return r;
  };
  const ntm = block(estQ.slice(0, 4)), ntm2 = block(estQ.slice(4, 8));
  const span = (b) => `${b.from.slice(2)}~${b.k.slice(2)}`;
  const roll = [];
  if (ntm.filled) roll.push({ ...ntm, label: `향후 4분기 (${span(ntm)})`, short: "향후 4분기", prev: cur });
  if (ntm2.filled) roll.push({ ...ntm2, label: `그다음 4분기 (${span(ntm2)})`, short: "그다음 4분기", prev: ntm.filled ? ntm : null });
  // 결산연도 합계: 실적 분기 + 내 추정 분기 (4개 분기가 다 있을 때만)
  const getQ = (i) => near(estQ, i) || near(Qact, i);
  const myFY = [];
  for (const q of estQ) {
    const off = [0, 1, -1].find((d) => (((q.i - d - fyMi) % 12) + 12) % 12 === 0);
    if (off === undefined) continue;
    const qs = [q.i - 9, q.i - 6, q.i - 3, q.i].map(getQ);
    const nEst = qs.filter((x) => x && estQ.includes(x)).length;
    const r = { k: q.k, year: Math.floor((q.i - off) / 12), nEst, rev: sum4(qs, "rev"), oi: sum4(qs, "oi"), ni: sum4(qs, "ni"), niAuto: qs.some((x) => x?.niAuto) };
    if (isNum(r.rev) || isNum(r.oi) || isNum(r.ni)) myFY.push(r);
  }
  const cons = (fin.cons?.annual || []).filter((c) => !lastA || c.k > lastA.k);
  const byK = new Map(A.map((a) => [a.k, a]));
  const prevOf = (k, chain) => chain.find((x) => x && Math.abs(mIdx(x.k) - (mIdx(k) - 12)) <= 1) || null;
  for (const f of myFY) f.prev = prevOf(f.k, [...myFY, ...A]);

  const fwd = (r) => ({
    per: pos(r.ni) ? mcap / r.ni : NaN, perLoss: isNum(r.ni) && r.ni <= 0,
    evebit: pos(r.oi) ? ev / r.oi : NaN, psr: pos(r.rev) ? mcap / r.rev : NaN,
    opm: pos(r.rev) && isNum(r.oi) ? r.oi / r.rev : NaN,
  });

  return { ccy, U, conv, shares, px, mcap, netDebt, ev, A, lastA, baseYear, cur, estQ, ntm, ntm2, roll, myFY, Qact, cons, niRatio, byK, prevOf, fwd, hasBs };
}

// ---------- 화면 ----------
export async function renderValuation(v) {
  const tok = v.dataset.tok;
  v.innerHTML = `<div class="skeleton">종목 분석 불러오는 중…</div>`;
  let d;
  try { d = await api(`/api/valuation${V.name ? `?name=${encodeURIComponent(V.name)}` : ""}`); }
  catch (e) { if (v.dataset.tok === tok) v.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; return; }
  if (v.dataset.tok !== tok) return;
  if (!d.items.length) { v.innerHTML = `<div class="empty">분석할 종목이 없어요 (보유 종목이나 관찰 종목을 먼저 추가해 주세요).</div>`; return; }
  draw(v, d);
}

function picker(items, sel) {
  const group = (g) => items.filter((i) => i.구분 === g);
  const chips = (list) => list.map((i) => `<button class="chip" data-pick="${esc(i.종목)}" aria-pressed="${i.종목 === sel}">${esc(i.종목)}</button>`).join("");
  return `<div class="val-pick">
    ${group("보유").length ? `<div class="pick-row"><span class="pick-label">보유</span><div class="chips">${chips(group("보유"))}</div></div>` : ""}
    ${group("관찰").length ? `<div class="pick-row"><span class="pick-label">관찰</span><div class="chips">${chips(group("관찰"))}</div></div>` : ""}
  </div>`;
}

function draw(v, d) {
  const card = d.card;
  const sel = card?.item?.종목;
  V.name = sel; store.set("valName", sel);
  const head = picker(d.items, sel);
  const reload = async (name, refresh = false) => {
    V.name = name;
    const tok = v.dataset.tok;
    const box = document.getElementById("valCard");
    if (box) box.innerHTML = `<div class="skeleton">${refresh ? "재무 데이터 새로 받는 중…" : "불러오는 중…"}</div>`;
    v.querySelectorAll("[data-pick]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.pick === name));
    try {
      const nd = await api(`/api/valuation?name=${encodeURIComponent(name)}${refresh ? "&refresh=1" : ""}`);
      if (v.dataset.tok === tok) draw(v, nd);
    } catch (e) { if (box) box.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; }
  };

  if (card && !card.error && !card.fin && card.item?.심볼) {
    // 재무가 없어도 (ETF 등) 기술적 분석은 된다
    const item = card.item;
    const inp = prepInputs(card);
    const S = saver(item, inp);
    v.innerHTML = `${head}<div id="valCard">
      <div class="section val-head"><div><h2 style="margin:0">${esc(item.종목)} <span class="sub">${esc(item.심볼)} · ${esc(item.구분)}</span></h2></div></div>
      ${paneSeg()}
      <div id="paneF" hidden><div class="notice err">재무 데이터를 못 받았어요${card.finError ? `: ${esc(card.finError)}` : ""}<br><span class="muted">ETF·펀드는 재무제표가 없어서 펀더멘털 분석은 안 돼요. 기술적 분석은 볼 수 있어요.</span></div></div>
      <div id="paneT" hidden></div></div>`;
    setupPanes(v, card, inp, S, "T");
    bindPick(v, reload);
    return;
  }
  if (!card || card.error || !card.fin) {
    v.innerHTML = `${head}<div id="valCard">${card?.error || card?.finError
      ? `<div class="notice ${card.error ? "warn" : "err"}">${esc(card.error || `재무 데이터를 못 받았어요: ${card.finError}`)}<br><span class="muted">ETF·펀드는 재무제표가 없어서 분석할 수 없어요.</span></div>`
      : `<div class="empty">재무 데이터가 없어요</div>`}</div>`;
    bindPick(v, reload);
    return;
  }

  const inp = prepInputs(card);
  const fin = card.fin, item = card.item;
  // 분기 입력 상태: 저장된 분기 키가 화면 분기와 한 달 어긋나면 화면 키로 맞춘다 (지난 분기 추정은 그대로 보관)
  const M0 = model(card, inp);
  for (const q of M0.estQ) {
    const sv = q.savedK && q.savedK !== q.k ? inp.quarters.find((x) => x.k === q.savedK) : null;
    if (sv && !inp.quarters.some((x) => x.k === q.k)) sv.k = q.k;
  }
  const qState = new Map(inp.quarters.map((q) => [q.k, q]));
  const U = M0.U;
  const S = saver(item, inp);

  v.innerHTML = `${head}
  <div id="valCard">
    <div class="section val-head">
      <div>
        <h2 style="margin:0">${esc(item.종목)} <span class="sub">${esc(item.심볼)} · ${esc(item.구분)} · 재무 ${esc(M0.ccy)} · 금액 단위 ${esc(U.label)}</span></h2>
        <div class="meta-row" style="margin-top:6px">
          <span>재무: Yahoo${item.심볼.match(/\.(KS|KQ)$/) ? " + 네이버(공시 실적·컨센서스)" : ""}</span>
          <span>받은 시각 ${new Date(fin.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
          ${fin.bs?.shares_k ? `<span>주식수·부채 기준 ${esc(fin.bs.shares_k)}</span>` : ""}
        </div>
      </div>
      <button class="btn ghost sm" id="finRefresh">재무 다시 받기</button>
    </div>
    ${paneSeg()}
    <div id="paneF" hidden>
    ${fin.warn ? `<div class="notice warn">${esc(fin.warn)}</div>` : ""}
    ${!isNum(M0.conv) ? `<div class="notice warn">주가 통화(${esc(item.통화)})와 재무 통화(${esc(M0.ccy)})가 달라서 환산을 못 해요. 시가총액 기반 지표는 비어 보여요. (ADR 이면 주식수 칸에 ADR 환산 주식수를 넣어 주세요.)</div>` : ""}
    <div id="valNow"></div>

    <div class="val-grid section">
      <div>
        <h2>내 추정 · 분기 <span class="sub">${esc(U.label)} · 순이익을 비우면 영업이익 × ${M0.niRatio.toFixed(2)}</span></h2>
        <div class="card val-form">
          <div class="table-wrap edit flat"><table class="data qform">
            <thead><tr><th class="l">분기</th><th>매출</th><th>영업이익</th><th>순이익</th></tr></thead>
            <tbody>${M0.estQ.map((q, j) => {
              const sv = qState.get(q.k) || {};
              const hint = (f) => q.cons && isNum(q.cons[f]) ? `컨센 ${roundIn(q.cons[f] / U.div)}` : q.ly && isNum(q.ly[f]) ? `작년 ${roundIn(q.ly[f] / U.div)}` : "";
              return `<tr class="${j === 4 ? "q-sep" : ""}"><td class="l ro">${q.k.slice(2, 4)}.${q.k.slice(5)} <span class="muted q-tag">${q.fq}Q</span></td>
                <td><input class="num" data-q="${q.k}" data-qf="rev" inputmode="decimal" value="${esc(showIn(sv.rev))}" placeholder="${esc(hint("rev"))}"></td>
                <td><input class="num" data-q="${q.k}" data-qf="oi" inputmode="decimal" value="${esc(showIn(sv.oi))}" placeholder="${esc(hint("oi"))}"></td>
                <td><input class="num" data-q="${q.k}" data-qf="ni" inputmode="decimal" value="${esc(showIn(sv.ni))}" placeholder="${esc(hint("ni") || "자동")}"></td></tr>`;
            }).join("")}</tbody>
            <tfoot id="qSums"></tfoot>
          </table></div>
          <p class="caption" style="margin-top:6px">흐린 숫자는 참고값이에요 (컨센서스, 없으면 1년 전 같은 분기 실적). 4개 분기를 다 채우면 합계로 Forward 지표·목표가를 계산해요.</p>
          <div class="form-grid" style="margin-top:14px">
            <label class="field"><span>적정 PER · 약세</span><input class="num" data-f="PER_약세" inputmode="decimal" value="${esc(showIn(inp.PER_약세))}"></label>
            <label class="field"><span>기준</span><input class="num" data-f="PER_기준" inputmode="decimal" value="${esc(showIn(inp.PER_기준))}"></label>
            <label class="field"><span>강세</span><input class="num" data-f="PER_강세" inputmode="decimal" value="${esc(showIn(inp.PER_강세))}"></label>
          </div>
          <div class="form-grid" style="margin-top:12px">
            <label class="field"><span>주식수 <small>비우면 자동</small></span><input class="num" data-f="주식수" inputmode="numeric" value="${esc(showIn(inp.주식수))}" placeholder="${isNum(fin.bs?.shares) ? fin.bs.shares.toLocaleString("ko-KR") : ""}"></label>
          </div>
          <label class="field" style="display:flex;margin-top:12px"><span>메모 <small>투자 논지 · 틀렸다고 볼 조건</small></span><textarea data-f="메모" rows="3">${esc(inp.메모 || "")}</textarea></label>
          ${S.saveBtn()}
        </div>
      </div>
      <div id="valTgt"></div>
    </div>
    <div id="valFwd" class="section"></div>
    <div class="section">
      <h2>Reverse DCF <span class="sub" id="dcfSub"></span></h2>
      <div class="card dcf-ctl">
        <label class="field"><span>할인율 %</span><input class="num" data-f="할인율" inputmode="decimal" value="${esc(showIn(inp.할인율))}" placeholder="${defR(M0.ccy) * 100} (기본)"></label>
        <label class="field"><span>영구성장률 %</span><input class="num" data-f="영구성장률" inputmode="decimal" value="${esc(showIn(inp.영구성장률))}" placeholder="2.5 (기본)"></label>
        <label class="field wide"><span>기준 현금흐름</span><select data-f="DCF_기준">${DCF_BASES.map(([k, l]) => `<option value="${k}" ${inp.DCF_기준 === k ? "selected" : ""}>${l}</option>`).join("")}<option value="" ${!inp.DCF_기준 ? "selected" : ""}>자동 (FCF, 없으면 순이익)</option></select></label>
        <span class="muted dcf-note">할인율은 요구수익률이에요. 비우면 원화 종목 ${defR("KRW") * 100}%, 그 외 ${defR("USD") * 100}%. 아래 민감도 표의 할인율을 눌러도 바뀌어요. 저장 버튼으로 같이 저장돼요.</span>
      </div>
      <div id="valDcf"></div>
    </div>
    <div id="valGrowth"></div>
    </div>
    <div id="paneT" hidden></div>
  </div>`;

  const out = () => drawOutputs(card, inp);
  out();
  bindPick(v, reload);
  document.getElementById("finRefresh").addEventListener("click", () => reload(item.종목, true));

  const markDirty = S.markDirty;
  v.querySelectorAll("#valCard [data-q]").forEach((el) => {
    const k = el.dataset.q, f = el.dataset.qf;
    el.addEventListener("input", () => {
      let q = qState.get(k);
      if (!q) { q = { k }; qState.set(k, q); inp.quarters.push(q); }
      q[f] = parseIn(el.value);
      el.classList.toggle("invalid", Number.isNaN(q[f]));
      markDirty();
      out();
    });
    el.addEventListener("blur", () => { const x = qState.get(k)?.[f]; if (isNum(x)) el.value = showIn(x); });
  });
  v.querySelectorAll("#valCard [data-f]").forEach((el) => {
    const f = el.dataset.f;
    const isText = el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    el.addEventListener(el.tagName === "SELECT" ? "change" : "input", () => {
      inp[f] = isText ? el.value : parseIn(el.value);
      if (!isText) el.classList.toggle("invalid", Number.isNaN(inp[f]));
      markDirty();
      out();
    });
    if (!isText) el.addEventListener("blur", () => { if (isNum(inp[f])) el.value = showIn(inp[f]); });
  });
  document.getElementById("valDcf").addEventListener("click", (e) => {
    const c = e.target.closest("[data-r]");
    if (!c) return;
    const el = v.querySelector('#valCard [data-f="할인율"]');
    el.value = c.dataset.r;
    el.dispatchEvent(new Event("input"));
  });
  S.bind(v.querySelector("#paneF"));
  setupPanes(v, card, inp, S);
}

function prepInputs(card) {
  const inp = { ...(card.inputs || {}) };
  for (const k of ["할인율", "영구성장률"]) if (!isNum(inp[k])) inp[k] = null;
  inp.quarters = (inp.quarters || []).map((q) => ({ ...q }));
  return inp;
}

/** 저장: 펀더멘털·기술적 분석 두 화면이 같은 입력(inp)을 같이 저장한다 */
function saver(item, inp) {
  const st = { dirty: false };
  const states = () => document.querySelectorAll(".val-state");
  const stateTxt = () => (st.dirty ? "저장 안 된 변경 있음" : inp.업데이트일 ? `마지막 저장 ${inp.업데이트일}` : "아직 저장 안 함");
  const markDirty = () => { if (!st.dirty) { st.dirty = true; states().forEach((e) => (e.textContent = stateTxt())); } };
  const saveBtn = () => `<div class="toolbar actions"><button class="btn primary" data-save>저장</button><span class="muted val-state" style="font-size:13px">${esc(stateTxt())}</span></div>`;
  const save = async (b) => {
    const badQ = inp.quarters.some((q) => ["rev", "oi", "ni"].some((f) => Number.isNaN(q[f])));
    if (badQ || Object.values(inp).some((x) => Number.isNaN(x))) { toast("숫자가 아닌 칸이 있어요 (빨간 칸).", "err"); return; }
    b.disabled = true; b.textContent = "저장 중…";
    try {
      const r = await api("/api/valuation", { method: "PUT", body: JSON.stringify({ 종목: item.종목, inputs: inp }) });
      inp.업데이트일 = r.업데이트일; st.dirty = false;
      states().forEach((e) => (e.textContent = stateTxt()));
      toast("저장했어요");
    } catch (err) { toast(err.message, "err"); }
    b.disabled = false; b.textContent = "저장";
  };
  const bind = (root) => root?.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", () => save(b)));
  return { markDirty, saveBtn, bind };
}

const paneSeg = () => `<div class="pane-seg"><div class="seg" id="paneSeg"><button data-p="F">펀더멘털</button><button data-p="T">기술적 분석</button></div></div>`;

function setupPanes(v, card, inp, S, force) {
  const paneF = v.querySelector("#paneF"), paneT = v.querySelector("#paneT");
  let techDone = false;
  const show = (p, remember = true) => {
    if (remember) { V.pane = p; store.set("valPane", p); }
    paneF.hidden = p !== "F"; paneT.hidden = p !== "T";
    v.querySelectorAll("#paneSeg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.p === p));
    if (p === "T" && !techDone) {
      techDone = true;
      renderTech(paneT, card, inp, { dirty: S.markDirty, saveBtn: S.saveBtn, bind: S.bind });
    }
  };
  v.querySelector("#paneSeg").addEventListener("click", (e) => { const b = e.target.closest("[data-p]"); if (b) show(b.dataset.p); });
  show(force || V.pane, !force);
}

function bindPick(v, reload) {
  v.querySelectorAll("[data-pick]").forEach((b) => b.addEventListener("click", () => { store.set("valName", b.dataset.pick); reload(b.dataset.pick); }));
}

const DCF_BASES = [["FCF", "FCF (최근 4분기)"], ["순이익", "순이익 (최근 4분기)"], ["추정", "내 추정 향후 4분기 순이익"]];
const defR = (ccy) => (ccy === "KRW" ? 0.1 : 0.09);

function drawOutputs(card, inp) {
  const M = model(card, inp);
  const { U, cur } = M;
  const amt = (x) => (isNum(x) ? (Math.abs(x / U.div) >= 100 ? Math.round(x / U.div).toLocaleString("ko-KR") : (x / U.div).toLocaleString("ko-KR", { maximumFractionDigits: 1 })) : "-");
  const pxTxt = (x) => fmt.price(x, card.item.통화);

  // --- 지금 ---
  const f0 = cur ? M.fwd(cur) : {};
  const fcfY = cur && isNum(cur.fcf) && pos(M.mcap) ? cur.fcf / M.mcap : NaN;
  document.getElementById("valNow").innerHTML = `
    <div class="metrics section">
      <div class="metric"><div class="label">현재가</div><div class="value">${pxTxt(M.px)} <small class="muted" style="font-size:13px">${esc(card.item.통화)}</small></div><div class="delta muted">${esc(card.price?.d || "가격 없음")}</div></div>
      <div class="metric"><div class="label">시가총액</div><div class="value">${amt(M.mcap)}</div><div class="delta muted">${esc(U.label)}</div></div>
      <div class="metric"><div class="label">${isNum(M.netDebt) && M.netDebt < 0 ? "순현금" : "순부채"}</div><div class="value">${amt(isNum(M.netDebt) ? Math.abs(M.netDebt) : NaN)}</div><div class="delta muted">EV ${amt(M.ev)}</div></div>
      <div class="metric"><div class="label">PER <small>${cur ? esc(cur.label) : ""}</small></div><div class="value">${f0.perLoss ? "적자" : mult(f0.per)}</div><div class="delta muted">PSR ${mult(f0.psr)}</div></div>
      <div class="metric"><div class="label">EV/EBIT</div><div class="value">${mult(f0.evebit)}</div><div class="delta muted">영업이익률 ${isNum(f0.opm) ? (f0.opm * 100).toFixed(1) + "%" : "-"}</div></div>
      <div class="metric"><div class="label">FCF 수익률</div><div class="value ${cls(fcfY)}">${isNum(fcfY) ? (fcfY * 100).toFixed(1) + "%" : "-"}</div><div class="delta muted">FCF ${amt(cur?.fcf)}</div></div>
    </div>`;

  // --- Forward ---
  // 분기 입력 아래 합계
  const sumRow = (label, b) => `<tr><td class="l ro">${label}</td>${["rev", "oi", "ni"].map((f) => `<td class="${isNum(b[f]) ? "" : "muted"}">${amt(b[f])}</td>`).join("")}</tr>`;
  const qs = document.getElementById("qSums");
  if (qs) qs.innerHTML = sumRow("향후 4분기", M.ntm) + sumRow("그다음 4분기", M.ntm2);

  const rows = [];
  if (cur) rows.push({ label: cur.label, kind: "a", r: cur, prev: null });
  for (const b of M.roll) rows.push({ label: `${b.label} 내 추정`, kind: "m", r: b, prev: b.prev });
  for (const c of M.cons) rows.push({ label: `${c.k.slice(0, 4)} 컨센서스`, kind: "c", r: c, prev: M.prevOf(c.k, [...M.cons, ...M.A]) });
  const fyLabel = (f) => `${f.year} 내 추정${f.nEst < 4 ? ` (실적 ${4 - f.nEst}+추정 ${f.nEst}분기)` : ""}`;
  for (const f of M.myFY) rows.push({ label: fyLabel(f), kind: "m", r: f, prev: f.prev });
  const est = [...M.roll.map((b) => ({ ...b, tl: b.short })), ...M.myFY.map((f) => ({ ...f, tl: `${f.year} 연간` }))];
  const tgt = [["약세", inp.PER_약세], ["기준", inp.PER_기준], ["강세", inp.PER_강세]].filter(([, x]) => pos(x));
  const tPrice = (per, e) => (pos(e.ni) && pos(M.mcap) ? (M.px * per * e.ni) / M.mcap : NaN);
  document.getElementById("valFwd").innerHTML = `
    <h2>Forward 지표 <span class="sub">지금 시가총액 기준</span></h2>
    <div class="table-wrap"><table class="data">
      <thead><tr><th class="l sticky"></th><th>매출</th><th>영업이익</th><th>순이익</th><th>매출 성장</th><th>영업이익 성장</th><th>영업이익률</th><th>PER</th><th>EV/EBIT</th><th>PSR</th></tr></thead>
      <tbody>${rows.map(({ label, kind, r, prev }) => { const f = M.fwd(r); return `<tr class="row-${kind}">
        <td class="l sticky">${esc(label)}</td><td>${amt(r.rev)}</td><td>${amt(r.oi)}</td><td>${amt(r.ni)}${r.niAuto ? `<span class="muted"> 자동</span>` : ""}</td>
        <td>${prev ? gCell(growth(prev.rev, r.rev)) : `<span class="muted">-</span>`}</td><td>${prev ? gCell(growth(prev.oi, r.oi)) : `<span class="muted">-</span>`}</td>
        <td>${isNum(f.opm) ? (f.opm * 100).toFixed(1) + "%" : "-"}</td>
        <td><b>${f.perLoss ? "적자" : mult(f.per)}</b></td><td>${mult(f.evebit)}</td><td>${mult(f.psr)}</td></tr>`; }).join("")}</tbody>
    </table></div>
    ${!est.length ? `<p class="caption">내 추정 분기 4개를 채우면 여기 Forward PER·EV/EBIT 가 나와요.</p>` : ""}`;
  const estT = est.filter((e) => pos(e.ni));
  document.getElementById("valTgt").innerHTML = `
    <h2>목표가 <span class="sub">적정 PER × 추정 순이익 ÷ 주식수</span></h2>
    ${tgt.length && estT.length ? `<div class="table-wrap"><table class="data tgt">
      <thead><tr><th class="l">기준 순이익</th>${tgt.map(([l, per]) => `<th>${l}<div class="th-sub">PER ${per}배</div></th>`).join("")}</tr></thead>
      <tbody>${estT.map((e) => `<tr><td class="l">${esc(e.tl)}<div class="th-sub">${amt(e.ni)}${e.niAuto ? " · 자동 포함" : ""}</div></td>${tgt.map(([, per]) => { const t = tPrice(per, e); return `<td><b>${pxTxt(t)}</b><div class="${cls(t / M.px - 1)}" style="font-size:12px">${pctTxt(t / M.px - 1)}</div></td>`; }).join("")}</tr>`).join("")}</tbody>
    </table></div>` : `<div class="empty card">내 추정 분기 4개와 적정 PER(약세·기준·강세 중 하나 이상)을 넣으면 목표가가 나와요.</div>`}`;

  // --- Reverse DCF ---
  const r = isNum(inp.할인율) ? inp.할인율 / 100 : defR(M.ccy);
  const gT = isNum(inp.영구성장률) ? inp.영구성장률 / 100 : 0.025;
  let base = inp.DCF_기준 || (cur && pos(cur.fcf) ? "FCF" : "순이익");
  const baseCf = { FCF: cur?.fcf, 순이익: cur?.ni, 추정: M.ntm.ni }[base];
  const target = base === "FCF" ? M.ev : M.mcap;
  const res = impliedG(baseCf, target, r, gT);
  const lastIdx = M.lastA ? mIdx(M.lastA.k) : 0;
  const a3 = M.A.find((a) => Math.abs(mIdx(a.k) - (lastIdx - 36)) <= 1);
  const cagr = (f) => (a3 && M.lastA && pos(a3[f]) && pos(M.lastA[f]) ? (M.lastA[f] / a3[f]) ** (1 / 3) - 1 : NaN);
  const myG = cur && pos(cur.rev) && pos(M.ntm.rev) ? M.ntm.rev / cur.rev - 1 : NaN;
  const sens = [-0.02, -0.01, 0, 0.01, 0.02].map((dr) => ({ r: r + dr, x: impliedG(baseCf, target, r + dr, gT) }));
  const gTxt = (x) => (!x ? "-" : x.edge === "below" ? "-50% 미만" : x.edge === "above" ? "+150% 초과" : pctTxt(x.g));
  document.getElementById("dcfSub").textContent = `지금 ${base === "FCF" ? "기업가치(EV)" : "시가총액"}을 정당화하려면 앞으로 10년간 ${DCF_BASES.find((b) => b[0] === base)?.[1] || base}이 매년 얼마나 커야 하나`;
  document.getElementById("valDcf").innerHTML = `
      ${res ? `<div class="metrics">
        <div class="metric hero"><div class="label">시장이 가정한 연 성장률 (10년)</div><div class="value">${gTxt(res)}</div><div class="delta">기준 ${amt(baseCf)} → 10년 뒤 ${res.edge ? "-" : amt(baseCf * (1 + res.g) ** 10)} ${esc(U.label)}</div></div>
        <div class="metric"><div class="label">과거 3년 매출 CAGR</div><div class="value ${cls(cagr("rev"))}">${pctTxt(cagr("rev"))}</div><div class="delta muted">${a3 ? `${esc(a3.k)} → ${esc(M.lastA.k)}` : "실적 3년치 부족"}</div></div>
        <div class="metric"><div class="label">과거 3년 영업이익 CAGR</div><div class="value ${cls(cagr("oi"))}">${pctTxt(cagr("oi"))}</div></div>
        <div class="metric"><div class="label">내 추정 매출 성장 (향후 4분기)</div><div class="value ${cls(myG)}">${pctTxt(myG)}</div><div class="delta muted">${cur ? esc(cur.label) : ""} 대비</div></div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table class="data">
        <thead><tr><th class="l">할인율</th>${sens.map((x) => `<th class="pick-r${x.r === r ? " hl" : ""}" data-r="${Math.round(x.r * 1000) / 10}" title="이 할인율로 바꾸기">${(x.r * 100).toFixed(1)}%</th>`).join("")}</tr></thead>
        <tbody><tr><td class="l">내재 성장률</td>${sens.map((x) => `<td class="pick-r${x.r === r ? " hl" : ""}" data-r="${Math.round(x.r * 1000) / 10}">${gTxt(x.x)}</td>`).join("")}</tr></tbody>
      </table></div>
      <p class="caption">할인율 ${(r * 100).toFixed(1)}% · 10년 뒤 영구성장 ${(gT * 100).toFixed(1)}%. 시장 가정이 과거 성장률이나 내 추정보다 높으면 기대가 이미 주가에 많이 들어가 있다는 뜻이에요.</p>`
      : `<div class="notice warn">${!pos(baseCf) ? `기준 현금흐름(${esc(base)})이 0 이하이거나 비어 있어서 Reverse DCF를 계산할 수 없어요. 기준을 바꾸거나 내 추정 분기 4개를 채워 보세요.` : !pos(target) ? "시가총액/EV 를 계산할 수 없어요 (가격·주식수 확인)." : "할인율이 영구성장률보다 커야 해요."}</div>`}`;

  // --- 성장률·가속도 ---
  document.getElementById("valGrowth").innerHTML = growthTables(card, M, amt);
}

function growthTables(card, M, amt) {
  const fin = card.fin;
  // 연간: 실적 → (컨센서스) → (내 추정)
  const isKr = /\.(KS|KQ)$/.test(card.item.심볼);
  const colsA = M.A.slice(-6).map((a) => ({ label: a.k.slice(0, 4), sub: (a.k.slice(5) === "12" ? "실적" : `실적 (${a.k.slice(5)}월 결산)`) + (isKr && a.src === "yahoo" ? " · Yahoo" : ""), kind: "a", ...a }));
  const chainA = [...M.A];
  for (const c of M.cons) colsA.push({ label: c.k.slice(0, 4), sub: "컨센서스", kind: "c", ...c });
  const est = M.myFY;
  for (const e of est) colsA.push({ label: String(e.year), sub: e.nEst < 4 ? `내 추정 (실적 ${4 - e.nEst}+${e.nEst}분기)` : "내 추정", kind: "m", ...e });
  const prevA = (c) => (c.kind === "a" ? M.prevOf(c.k, chainA) : c.kind === "c" ? M.prevOf(c.k, [...M.cons, ...chainA]) : M.prevOf(c.k, [...est, ...chainA]));
  for (const c of colsA) {
    const p = prevA(c);
    c.gRev = p ? growth(p.rev, c.rev) : null; c.gOi = p ? growth(p.oi, c.oi) : null;
    const pp = p ? prevA({ ...p, kind: M.cons.includes(p) ? "c" : est.includes(p) ? "m" : "a" }) : null;
    c.aRev = p && pp ? accel(c.gRev, growth(pp.rev, p.rev)) : null;
    c.aOi = p && pp ? accel(c.gOi, growth(pp.oi, p.oi)) : null;
    c.opm = pos(c.rev) && isNum(c.oi) ? c.oi / c.rev : NaN;
    c.dOpm = p && pos(p.rev) && isNum(p.oi) && isNum(c.opm) ? c.opm - p.oi / p.rev : NaN;
  }

  // 분기: 저장된 실적 분기 (최근 8개) → 컨센서스 분기 → 내 추정 분기. 성장률은 각자 실적에 이어 붙인 줄에서 계산
  const Qall = M.Qact;
  const consQ = (fin.cons?.quarterly || []).filter((c) => !Qall.length || c.k > Qall[Qall.length - 1].k).map((c) => ({ ...c, kind: "c" }));
  const myQ = M.estQ.filter((q) => q.filled).map((q) => ({ ...q, kind: "m" }));
  const chains = { a: Qall, c: [...Qall, ...consQ], m: [...Qall, ...myQ] };
  const colsQ = [...Qall.slice(-8).map((q) => ({ ...q, kind: "a" })), ...consQ, ...myQ].map((q) => {
    const chainQ = chains[q.kind];
    const at = (k, back) => chainQ.find((x) => Math.abs(mIdx(x.k) - (mIdx(k) - back)) <= 1) || null;
    const y = at(q.k, 12), p = at(q.k, 3), py = p ? at(p.k, 12) : null;
    const gR = y ? growth(y.rev, q.rev) : null, gO = y ? growth(y.oi, q.oi) : null;
    const opm = pos(q.rev) && isNum(q.oi) ? q.oi / q.rev : NaN;
    return {
      ...q, label: `${q.k.slice(2, 4)}.${q.k.slice(5)}`, sub: q.kind === "c" ? "컨센서스" : q.kind === "m" ? "내 추정" : q.d ? "연간−분기 계산" : "실적",
      yRev: gR, yOi: gO,
      aRev: p && py ? accel(gR, growth(py.rev, p.rev)) : null, aOi: p && py ? accel(gO, growth(py.oi, p.oi)) : null,
      qRev: p ? growth(p.rev, q.rev) : null, qOi: p ? growth(p.oi, q.oi) : null,
      opm, dOpm: y && pos(y.rev) && isNum(y.oi) && isNum(opm) ? opm - y.oi / y.rev : NaN,
    };
  });

  const head = (cols) => `<thead><tr><th class="l sticky"></th>${cols.map((c) => `<th class="col-${c.kind || (c.e ? "c" : "a")}">${esc(c.label)}<div class="th-sub">${esc(c.sub)}</div></th>`).join("")}</tr></thead>`;
  const row = (label, cols, fn, extra = "") => `<tr class="${extra}"><td class="l sticky">${label}</td>${cols.map((c) => `<td class="col-${c.kind || (c.e ? "c" : "a")}">${fn(c)}</td>`).join("")}</tr>`;
  const pctV = (x) => (isNum(x) ? `${(x * 100).toFixed(1)}%` : `<span class="muted">-</span>`);

  return `
    <div class="section"><h2>성장률과 가속도 · 연간 <span class="sub">${esc(M.U.label)} · 가속도 = 이번 성장률 − 직전 성장률 (%p)</span></h2>
      ${colsA.length ? `<div class="table-wrap"><table class="data gtable">${head(colsA)}<tbody>
        ${row("매출", colsA, (c) => amt(c.rev), "r-val")}
        ${row("매출 성장률", colsA, (c) => gCell(c.gRev))}
        ${row("매출 가속도", colsA, (c) => aCell(c.aRev), "r-acc")}
        ${row("영업이익", colsA, (c) => amt(c.oi), "r-val")}
        ${row("영업이익 성장률", colsA, (c) => gCell(c.gOi))}
        ${row("영업이익 가속도", colsA, (c) => aCell(c.aOi), "r-acc")}
        ${row("영업이익률", colsA, (c) => pctV(c.opm), "r-val")}
        ${row("영업이익률 변화", colsA, (c) => ppCell(c.dOpm))}
        ${row("순이익", colsA, (c) => amt(c.ni), "r-val")}
      </tbody></table></div>
      ${isKr && colsA.some((c) => c.src === "yahoo") ? `<p class="caption">한국 종목은 네이버(공시 기준) 값을 쓰고, 네이버에 없는 오래된 연도만 Yahoo 값이에요. 두 출처는 집계 기준이 조금 달라서 경계 연도의 성장률은 참고만 해 주세요.</p>` : ""}`
      : `<div class="empty">연간 실적이 없어요</div>`}
    </div>
    <div class="section"><h2>성장률과 가속도 · 분기 <span class="sub">YoY = 1년 전 같은 분기 대비 · YoY 가속도 = 이번 분기 YoY − 직전 분기 YoY</span></h2>
      ${colsQ.length ? `<div class="table-wrap"><table class="data gtable">${head(colsQ)}<tbody>
        ${row("매출", colsQ, (c) => amt(c.rev), "r-val")}
        ${row("매출 YoY", colsQ, (c) => gCell(c.yRev))}
        ${row("매출 YoY 가속도", colsQ, (c) => aCell(c.aRev), "r-acc")}
        ${row("매출 QoQ", colsQ, (c) => gCell(c.qRev))}
        ${row("영업이익", colsQ, (c) => amt(c.oi), "r-val")}
        ${row("영업이익 YoY", colsQ, (c) => gCell(c.yOi))}
        ${row("영업이익 YoY 가속도", colsQ, (c) => aCell(c.aOi), "r-acc")}
        ${row("영업이익 QoQ", colsQ, (c) => gCell(c.qOi))}
        ${row("영업이익률", colsQ, (c) => pctV(c.opm), "r-val")}
        ${row("영업이익률 YoY 변화", colsQ, (c) => ppCell(c.dOpm))}
      </tbody></table></div>
      <p class="caption">무료 데이터는 분기 5개까지만 줘서 처음엔 YoY 칸이 적어요. 받을 때마다 지난 분기를 쌓아 두니까 시간이 지나면 채워져요. '연간−분기 계산'은 연간 실적에서 나머지 세 분기를 뺀 값이에요.</p>`
      : `<div class="empty">분기 실적이 없어요</div>`}
    </div>`;
}
