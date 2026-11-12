// 편집 화면들 (관리자 전용): 스냅샷 · 자금 흐름/부채 · 종목 메모 · 관찰 종목 · 순서 · 설정
import { esc, isNum, fmt, api } from "./util.js";

const CCYS = ["KRW", "USD", "EUR", "JPY"];
const CASH = new Set(["KRW현금", "USD현금", "EUR현금", "JPY현금", "개인연금", "퇴직연금"]);
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// ---------- 알림 ----------
export function toast(msg, kind = "ok") {
  let box = document.getElementById("toasts");
  if (!box) { box = document.createElement("div"); box.id = "toasts"; document.body.appendChild(box); }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add("out"), kind === "err" ? 6000 : 3000);
  setTimeout(() => t.remove(), kind === "err" ? 6600 : 3600);
}

/** 버튼을 누르는 동안 잠그고, 오류는 알림으로 */
async function busy(btn, label, fn) {
  const old = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = label;
  try { return await fn(); }
  catch (e) { toast(e.message, "err"); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}

// ---------- 숫자 입력 ----------
const parseNum = (s) => {
  const t = String(s ?? "").replace(/[,\s₩]/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};
const showNum = (v, maxFrac = 6) => (isNum(v) ? v.toLocaleString("ko-KR", { maximumFractionDigits: maxFrac }) : "");

// ---------- 편집 표 ----------
/**
 * columns: [{key, label, type:'text'|'num'|'select'|'date'|'memo'|'ro', options, frac, width, ro(row)}]
 * opts: {deletable, onChange(row, key, api), rowClass(row)}
 * → { rows, render(), refresh(i), el }
 */
export function editGrid(container, columns, rows, opts = {}) {
  const g = { rows: rows.map((r) => ({ ...r })) };
  const cellHtml = (r, c, i) => {
    const v = r[c.key];
    const ro = c.type === "ro" || (c.ro && c.ro(r));
    if (ro) return `<td class="${c.type === "num" || c.align === "r" ? "" : "l"} ro">${c.fmt ? c.fmt(v, r) : esc(v ?? "")}</td>`;
    const st = c.width ? ` style="min-width:${c.width}px"` : "";
    if (c.type === "select") return `<td class="l"><select data-i="${i}" data-k="${c.key}"${st}>${c.options.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></td>`;
    if (c.type === "memo") return `<td class="l"><textarea rows="2" data-i="${i}" data-k="${c.key}"${st}>${esc(v ?? "")}</textarea></td>`;
    if (c.type === "num") return `<td><input class="num" inputmode="decimal" data-i="${i}" data-k="${c.key}" data-num="1" data-frac="${c.frac ?? 6}" value="${esc(showNum(v, c.frac ?? 6))}"${st}></td>`;
    if (c.type === "date") return `<td class="l"><input type="date" data-i="${i}" data-k="${c.key}" value="${esc(v ?? "")}"${st}></td>`;
    return `<td class="l"><input data-i="${i}" data-k="${c.key}" value="${esc(v ?? "")}"${st}></td>`;
  };
  g.render = () => {
    container.innerHTML = `<div class="table-wrap edit"><table class="data">
      <thead><tr>${columns.map((c) => `<th class="${c.type === "num" || c.align === "r" ? "" : "l"}">${c.label}</th>`).join("")}${opts.deletable ? "<th></th>" : ""}</tr></thead>
      <tbody>${g.rows.map((r, i) => `<tr data-row="${i}" class="${opts.rowClass ? opts.rowClass(r) : ""}">${columns.map((c) => cellHtml(r, c, i)).join("")}${opts.deletable ? `<td><button class="del" data-del="${i}" title="이 행 지우기" aria-label="행 삭제">✕</button></td>` : ""}</tr>`).join("")}</tbody>
    </table></div>`;
    container.querySelectorAll("[data-k]").forEach((inp) => {
      const i = +inp.dataset.i, k = inp.dataset.k;
      const isN = inp.dataset.num === "1";
      inp.addEventListener("input", () => {
        g.rows[i][k] = isN ? parseNum(inp.value) : inp.value;
        g.rows[i]._dirty = true;
        opts.onChange?.(g.rows[i], k, g, i);
      });
      if (isN) {
        inp.addEventListener("focus", () => { const v = g.rows[i][k]; inp.value = isNum(v) ? String(v) : (inp.value || ""); inp.select(); });
        inp.addEventListener("blur", () => { const v = g.rows[i][k]; inp.value = isNum(v) ? showNum(v, +inp.dataset.frac) : inp.value; inp.classList.toggle("invalid", Number.isNaN(v)); });
      }
    });
    container.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => { g.rows.splice(+b.dataset.del, 1); g.render(); opts.onChange?.(null, null, g); }));
  };
  /** i행의 key 칸만 다시 그림 (입력 중인 칸은 건드리지 않음) */
  g.setCell = (i, key, v) => {
    g.rows[i][key] = v;
    const inp = container.querySelector(`[data-i="${i}"][data-k="${key}"]`);
    if (inp && document.activeElement !== inp) inp.value = inp.dataset.num === "1" ? showNum(v, +inp.dataset.frac) : (v ?? "");
  };
  g.add = (row) => { g.rows.push(row); g.render(); container.querySelector(`tr[data-row="${g.rows.length - 1}"] input`)?.focus(); };
  g.render();
  return g;
}

// =====================================================================
// 📸 스냅샷
// =====================================================================
const SNAP_COLS = [
  { key: "종목", label: "종목", type: "text", width: 120 },
  { key: "통화", label: "통화", type: "select", options: CCYS },
  { key: "수량", label: "수량", type: "num", frac: 6, width: 110 },
  { key: "평균단가", label: "평균단가", type: "num", frac: 6, width: 100 },
  { key: "현재가", label: "현재가", type: "num", frac: 6, width: 100 },
  { key: "환율", label: "환율", type: "num", frac: 4, width: 80 },
  { key: "평가액", label: "평가액 (원)", type: "num", frac: 0, width: 130 },
];

export async function renderSnapshots(v, ctx, state = {}) {
  const tok = v.dataset.tok;
  const mode = state.mode || "new";
  const date = state.date || todayKst();
  v.innerHTML = `<div class="skeleton">스냅샷 불러오는 중…</div>`;
  let d;
  try { d = await api(`/api/snapshots?date=${date}&mode=${mode}`); }
  catch (e) { v.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; return; }
  if (v.dataset.tok !== tok) return; // 그새 다른 탭으로 감
  const editDate = mode === "edit" ? (d.exists ? date : d.dates[0]?.날짜) : null;
  if (mode === "edit" && editDate && editDate !== date) return renderSnapshots(v, ctx, { mode, date: editDate });

  v.innerHTML = `
    <div class="section"><h2>📸 스냅샷 <span class="sub">진실의 원천 · 같은 날짜의 행들이 한 스냅샷</span></h2>
      <div class="toolbar">
        <div class="seg" role="group"><button data-mode="new" aria-pressed="${mode === "new"}">새 스냅샷</button><button data-mode="edit" aria-pressed="${mode === "edit"}">기존 스냅샷 편집</button></div>
        ${mode === "new"
          ? `<label class="field">날짜 <input type="date" id="snapDate" value="${d.date}" max="${todayKst()}"></label>`
          : `<label class="field">날짜 <select id="snapDate">${d.dates.map((x) => `<option value="${x.날짜}" ${x.날짜 === d.date ? "selected" : ""}>${x.날짜} (${x.행수}행)</option>`).join("")}</select></label>`}
      </div>
      <p class="caption">${
        d.carryFrom ? `💡 가장 최근 스냅샷(${d.carryFrom})에서 수량·평균단가·통화를 가져왔어요. ` : d.exists && mode === "new" ? "⚠️ 이 날짜에 이미 스냅샷이 있어요 — 저장하면 덮어써요. " : ""}${
        d.isToday ? "오늘이라 현재가·환율·평가액은 지금 시세로 채웠어요 (10분 캐시)." : "과거 날짜라 그날의 현재가·환율·평가액을 직접 넣어 주세요 (시트에서 직접 고쳐도 돼요)."}</p>
    </div>
    <div id="snapGrid"></div>
    <div class="toolbar" style="margin-top:10px">
      <button class="btn ghost" id="addRow">＋ 행 추가</button>
      <span class="muted" id="snapSum"></span>
    </div>
    <div class="toolbar actions">
      <button class="btn primary" id="saveSnap">💾 저장</button>
      <button class="btn" id="refreshSnap" title="수량·평균단가는 표 그대로, 가격·환율만 지금 시세로 받아서 바로 저장">🔄 지금 시세로 갱신 + 저장</button>
      ${mode === "edit" ? `<button class="btn danger" id="delSnap">🗑️ 이 스냅샷 삭제</button>` : ""}
    </div>
    <p class="caption">수량 0인 행은 저장할 때 빠져요. 평가액은 수량·현재가·환율을 고치면 자동으로 다시 계산돼요 (직접 덮어써도 돼요).</p>
    <details class="more"><summary>🗒️ 시트 <code>snapshots</code> 탭 양식 (직접 편집용)</summary>
      <div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr><th class="l">열</th><th class="l">형식</th><th class="l">비고</th></tr></thead><tbody>
        <tr><td class="l">날짜</td><td class="l">YYYY-MM-DD</td><td class="l">같은 날짜의 모든 행이 한 스냅샷</td></tr>
        <tr><td class="l">종목</td><td class="l">문자</td><td class="l">현금은 KRW현금/USD현금/EUR현금/JPY현금, 연금은 개인연금/퇴직연금</td></tr>
        <tr><td class="l">통화</td><td class="l">KRW/USD/EUR/JPY</td><td class="l"></td></tr>
        <tr><td class="l">수량</td><td class="l">숫자</td><td class="l">현금·연금은 보유 금액</td></tr>
        <tr><td class="l">평균단가</td><td class="l">숫자 (현지 통화)</td><td class="l">현금·연금은 1</td></tr>
        <tr><td class="l">현재가</td><td class="l">숫자 (현지 통화)</td><td class="l">그 시점 가격</td></tr>
        <tr><td class="l">환율</td><td class="l">숫자 (1통화→원)</td><td class="l">KRW면 1</td></tr>
        <tr><td class="l">평가액</td><td class="l">숫자 (원)</td><td class="l">= 수량 × 현재가 × 환율 (자산 추이가 이 값을 그대로 씀)</td></tr>
      </tbody></table></div>
    </details>
    <div class="section"><h2>📜 스냅샷 목록 <span class="sub">${d.dates.length}개</span></h2>
      <div class="chips">${d.dates.slice(0, 60).map((x) => `<button class="chip" data-go="${x.날짜}">${x.날짜} <small>${x.행수}</small></button>`).join("")}${d.dates.length > 60 ? `<span class="muted">… 외 ${d.dates.length - 60}개</span>` : ""}</div>
    </div>`;

  const sumEl = v.querySelector("#snapSum");
  const updateSum = () => {
    const tot = g.rows.reduce((s, r) => s + (isNum(r.평가액) ? r.평가액 : 0), 0);
    sumEl.innerHTML = `평가액 합계 <b>${fmt.krw(tot)}</b> (${fmt.won(tot)}) · ${g.rows.length}행`;
  };
  const g = editGrid(v.querySelector("#snapGrid"), SNAP_COLS, d.rows, {
    deletable: true,
    onChange(row, key, grid, i) {
      if (row && ["수량", "현재가", "환율"].includes(key)) {
        if (isNum(row.수량) && isNum(row.현재가) && isNum(row.환율)) grid.setCell(i, "평가액", row.수량 * row.현재가 * row.환율);
      }
      if (row && key === "종목" && CASH.has(row.종목.trim())) {
        if (!isNum(row.평균단가)) grid.setCell(i, "평균단가", 1);
        if (!isNum(row.현재가)) grid.setCell(i, "현재가", 1);
      }
      if (row && key === "통화" && row.통화 === "KRW") grid.setCell(i, "환율", 1);
      updateSum();
    },
  });
  updateSum();

  const go = (s) => renderSnapshots(v, ctx, { mode, date, ...s });
  v.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => renderSnapshots(v, ctx, { mode: b.dataset.mode })));
  v.querySelector("#snapDate").addEventListener("change", (e) => { if (e.target.value) go({ date: e.target.value }); });
  v.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => renderSnapshots(v, ctx, { mode: "edit", date: b.dataset.go })));
  v.querySelector("#addRow").addEventListener("click", () => g.add({ 종목: "", 통화: "KRW", 수량: null, 평균단가: null, 현재가: null, 환율: 1, 평가액: null }));
  const bad = g.rows.some((r) => Number.isNaN(r.수량));
  v.querySelector("#saveSnap").addEventListener("click", (e) => busy(e.currentTarget, "⏳ 저장 중", async () => {
    if (g.rows.some((r) => Object.values(r).some((x) => Number.isNaN(x)))) throw new Error("숫자가 아닌 칸이 있어요 (빨간 칸 확인).");
    const r = await api("/api/snapshots", { method: "PUT", body: JSON.stringify({ date: d.date, rows: g.rows }) });
    toast(`✅ ${r.date} 저장: ${r.rows}행 · 합계 ${fmt.krw(r.total)}`);
    await ctx.afterSave();
    renderSnapshots(v, ctx, { mode: "edit", date: r.date });
  }));
  v.querySelector("#refreshSnap").addEventListener("click", (e) => busy(e.currentTarget, "⏳ 시세 받는 중", async () => {
    const r = await api("/api/snapshots/refresh", { method: "POST", body: JSON.stringify({ date: d.date, rows: g.rows }) });
    toast(`✅ ${r.date} 지금 시세로 저장: ${r.rows}행 · 합계 ${fmt.krw(r.total)}`);
    if (r.missing?.length) toast(`⚠️ 가격을 못 받은 종목: ${r.missing.join(", ")} — 현재가 칸을 직접 채워 주세요`, "err");
    await ctx.afterSave();
    renderSnapshots(v, ctx, { mode: "edit", date: r.date });
  }));
  v.querySelector("#delSnap")?.addEventListener("click", (e) => {
    if (!confirm(`${d.date} 스냅샷(${g.rows.length}행)을 시트에서 지울까요?`)) return;
    busy(e.currentTarget, "⏳ 삭제 중", async () => {
      const r = await api(`/api/snapshots?date=${d.date}`, { method: "DELETE" });
      toast(`🗑️ ${d.date} ${r.removed}행 삭제`);
      await ctx.afterSave();
      renderSnapshots(v, ctx, { mode: "edit" });
    });
  });
  void bad;
}

// =====================================================================
// 💸 외부 자금 흐름 + 부채
// =====================================================================
export async function renderFlows(v, ctx) {
  const tok = v.dataset.tok;
  v.innerHTML = `<div class="skeleton">불러오는 중…</div>`;
  let d;
  try { d = await api("/api/flows"); } catch (e) { v.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; return; }
  if (v.dataset.tok !== tok) return; // 그새 다른 탭으로 감
  const lastDebt = d.debt.length ? d.debt[d.debt.length - 1].부채 : 0;
  v.innerHTML = `
    <div class="section"><h2>💸 외부 자금 흐름 <span class="sub">밖에서 들어오거나 나간 돈만 (급여·송금·대출 입금/상환). 이자·배당·매매 차익은 스냅샷에 저절로 잡혀요</span></h2>
      <form class="card form-grid" id="flowForm">
        <label class="field">날짜<input type="date" name="날짜" value="${todayKst()}" required></label>
        <label class="field">통화<select name="통화">${CCYS.map((c) => `<option>${c}</option>`).join("")}</select></label>
        <label class="field">금액 <small>+ 유입 · − 유출</small><input name="금액" inputmode="decimal" placeholder="예: 1,000,000 또는 -500,000" required></label>
        <label class="field grow">메모<input name="메모" placeholder="예: 11월 급여 / 대출 입금"></label>
        <button class="btn primary" type="submit">＋ 추가</button>
      </form>
      <p class="caption">주말에 적어도 돼요 — 좌수 계산에는 다음 영업일(월요일)에 반영돼요.</p>
    </div>
    <div class="section"><h2>📋 자금 흐름 목록 <span class="sub">${d.flows.length}건 · 고치거나 지운 뒤 저장</span></h2>
      <div id="flowGrid"></div>
      <div class="toolbar actions"><button class="btn primary" id="saveFlows">💾 변경사항 저장</button><span class="muted" id="flowSum"></span></div>
    </div>
    <div class="section"><h2>🏦 부채 잔액 <span class="sub">입력한 날부터 다음 입력 전까지 같은 값 · 순자산 = 총자산 − 부채</span></h2>
      <form class="card form-grid" id="debtForm">
        <label class="field">날짜<input type="date" name="날짜" value="${todayKst()}" required></label>
        <label class="field">부채 잔액 (원)<input name="부채" inputmode="decimal" value="${showNum(lastDebt, 0)}" required></label>
        <label class="field grow">메모<input name="메모" placeholder="예: 전세대출 잔액"></label>
        <button class="btn primary" type="submit">💾 적용</button>
      </form>
      <div class="table-wrap" style="margin-top:10px"><table class="data"><thead><tr><th class="l">날짜</th><th>부채</th><th class="l">메모</th><th></th></tr></thead>
        <tbody>${[...d.debt].reverse().map((r) => `<tr><td class="l">${r.날짜}</td><td>${fmt.won(r.부채)}</td><td class="l">${esc(r.메모)}</td><td><button class="del" data-deldebt="${r.날짜}" aria-label="삭제">✕</button></td></tr>`).join("") || `<tr><td colspan="4" class="empty">기록 없음</td></tr>`}</tbody></table></div>
    </div>`;

  const rows = [...d.flows].reverse(); // 최근 것 위로
  const sumEl = v.querySelector("#flowSum");
  const g = editGrid(v.querySelector("#flowGrid"), [
    { key: "날짜", label: "날짜", type: "date" },
    { key: "통화", label: "통화", type: "select", options: CCYS },
    { key: "금액", label: "금액", type: "num", frac: 2, width: 130 },
    { key: "메모", label: "메모", type: "text", width: 200 },
  ], rows, { deletable: true, onChange: () => { sumEl.textContent = `${g.rows.length}건 (저장 전)`; } });

  v.querySelector("#flowForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const amt = parseNum(f.get("금액"));
    if (!isNum(amt) || amt === 0) return toast("금액이 0이거나 숫자가 아니에요", "err");
    busy(e.target.querySelector("button[type=submit]"), "⏳", async () => {
      await api("/api/flows", { method: "POST", body: JSON.stringify({ 날짜: f.get("날짜"), 통화: f.get("통화"), 금액: amt, 메모: f.get("메모") }) });
      toast(`✅ ${f.get("날짜")} ${amt > 0 ? "+" : "−"}${Math.abs(amt).toLocaleString("ko-KR")} ${f.get("통화")} 추가`);
      await ctx.afterSave();
      renderFlows(v, ctx);
    });
  });
  v.querySelector("#saveFlows").addEventListener("click", (e) => busy(e.currentTarget, "⏳ 저장 중", async () => {
    if (g.rows.some((r) => !isNum(r.금액) || !r.날짜)) throw new Error("날짜나 금액이 빈 행이 있어요.");
    const sorted = [...g.rows].sort((a, b) => (a.날짜 < b.날짜 ? -1 : a.날짜 > b.날짜 ? 1 : 0));
    const r = await api("/api/flows", { method: "PUT", body: JSON.stringify({ rows: sorted }) });
    toast(`✅ ${r.rows}건 저장`);
    await ctx.afterSave();
    renderFlows(v, ctx);
  }));
  v.querySelector("#debtForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const debt = parseNum(f.get("부채"));
    if (!isNum(debt) || debt < 0) return toast("부채 잔액을 0 이상 숫자로 넣어 주세요", "err");
    busy(e.target.querySelector("button[type=submit]"), "⏳", async () => {
      await api("/api/debt", { method: "POST", body: JSON.stringify({ 날짜: f.get("날짜"), 부채: debt, 메모: f.get("메모") }) });
      toast(`✅ ${f.get("날짜")} 부채 ${fmt.won(debt)}`);
      await ctx.afterSave();
      renderFlows(v, ctx);
    });
  });
  v.querySelectorAll("[data-deldebt]").forEach((b) => b.addEventListener("click", () => {
    if (!confirm(`${b.dataset.deldebt} 부채 기록을 지울까요?`)) return;
    busy(b, "⏳", async () => { await api(`/api/debt?date=${b.dataset.deldebt}`, { method: "DELETE" }); toast("🗑️ 삭제"); await ctx.afterSave(); renderFlows(v, ctx); });
  }));
}

// =====================================================================
// 🎯 종목 메모 편집 (보유) / 👁️ 관찰 종목
// =====================================================================
const pctCell = (x) => (isNum(x) ? `<span class="${x > 0 ? "up" : x < 0 ? "down" : ""}">${x >= 0 ? "+" : ""}${x.toFixed(1)}%</span>` : "-");
const priceFmt = (x, r) => fmt.price(x, r.통화);

function recalcRR(row, grid, i) {
  const cur = row.현재가;
  const up = isNum(cur) && isNum(row.목표가_상단) && cur > 0 ? ((row.목표가_상단 - cur) / cur) * 100 : null;
  const dn = isNum(cur) && isNum(row.목표가_하단) && cur > 0 ? ((row.목표가_하단 - cur) / cur) * 100 : null;
  row.업사이드_pct = up; row.다운사이드_pct = dn; row.RR = isNum(up) && isNum(dn) && dn < 0 ? up / Math.abs(dn) : null;
  const tr = grid && document.querySelector(`[data-grid="${grid.id}"] tr[data-row="${i}"]`);
  if (tr) {
    tr.querySelector(".c-up").innerHTML = pctCell(up);
    tr.querySelector(".c-dn").innerHTML = pctCell(dn);
    tr.querySelector(".c-rr").textContent = isNum(row.RR) ? row.RR.toFixed(2) : "-";
  }
}

const noteCols = (withAvg, symbol) => [
  { key: "종목", label: "종목", type: "ro" },
  symbol ? { key: "심볼", label: "심볼", type: "ro" } : { key: "카테고리", label: "카테고리", type: "ro" },
  { key: "통화", label: "통화", type: "ro" },
  ...(withAvg ? [{ key: "평균단가", label: "평균단가", type: "ro", align: "r", fmt: priceFmt }] : []),
  { key: "현재가", label: "현재가", type: "ro", align: "r", fmt: priceFmt },
  { key: "목표가_상단", label: "🎯 목표가(상단)", type: "num", frac: 4, width: 100 },
  { key: "업사이드_pct", label: "업사이드", type: "ro", align: "r", cls: "c-up", fmt: pctCell },
  { key: "목표가_하단", label: "🛡️ 목표가(하단)", type: "num", frac: 4, width: 100 },
  { key: "다운사이드_pct", label: "다운사이드", type: "ro", align: "r", cls: "c-dn", fmt: pctCell },
  { key: "RR", label: "R/R", type: "ro", align: "r", cls: "c-rr", fmt: (x) => (isNum(x) ? x.toFixed(2) : "-") },
  { key: "업사이드_메모", label: "📈 업사이드 메모", type: "memo", width: 220 },
  { key: "다운사이드_메모", label: "📉 다운사이드 메모", type: "memo", width: 220 },
  { key: "업데이트일", label: "업데이트", type: "ro" },
];

function tagRoCells(container, cols) {
  // ro 칸에 c-up/c-dn/c-rr 클래스 붙이기 (R/R 즉시 갱신용)
  container.querySelectorAll("tbody tr").forEach((tr) => {
    tr.querySelectorAll("td").forEach((td, k) => { if (cols[k]?.cls) td.classList.add(cols[k].cls); });
  });
}

let gridSeq = 0;
function noteGrid(container, rows, withAvg, symbol, deletable) {
  const cols = noteCols(withAvg, symbol);
  const id = `g${++gridSeq}`;
  container.dataset.grid = id;
  const g = editGrid(container, cols, rows, {
    deletable,
    onChange(row, key, grid, i) {
      if (!row) { tagRoCells(container, cols); return; }
      row.업데이트일 = todayKst();
      if (key === "목표가_상단" || key === "목표가_하단") recalcRR(row, grid, i);
    },
  });
  g.id = id;
  tagRoCells(container, cols);
  return g;
}

export function notesEditor(container, rows, ctx) {
  container.innerHTML = `<div id="ng"></div><div class="toolbar actions"><button class="btn primary" id="saveNotes">💾 보유 종목 메모 저장</button><span class="muted">고친 행은 업데이트일이 오늘로 바뀌어요</span></div>`;
  const g = noteGrid(container.querySelector("#ng"), rows, true, false, false);
  container.querySelector("#saveNotes").addEventListener("click", (e) => busy(e.currentTarget, "⏳ 저장 중", async () => {
    const r = await api("/api/notes", { method: "PUT", body: JSON.stringify({ rows: g.rows }) });
    toast(`✅ ${r.rows}개 종목 메모 저장`);
    await ctx.afterSave(true);
  }));
}

export function watchlistEditor(container, rows, ctx) {
  container.innerHTML = `
    <form class="card form-grid" id="wlForm">
      <label class="field">종목명<input name="종목" placeholder="예: 엔비디아" required></label>
      <label class="field">심볼 <small>yfinance 표기</small><input name="심볼" placeholder="NVDA · 005930.KS · 475960.KQ · 8725.T · AIXA.DE" required></label>
      <label class="field">통화<select name="통화">${CCYS.map((c) => `<option>${c}</option>`).join("")}</select></label>
      <button class="btn primary" type="submit">＋ 관찰 종목 등록</button>
    </form>
    <p class="caption">한국은 종목코드+.KS(코스피)/.KQ(코스닥), 미국은 티커, 일본은 코드+.T, 유럽은 Yahoo 표기(.DE, .PA, .AS, .L …). 현재가는 10분 안에 붙어요.</p>
    <div id="wg" style="margin-top:10px"></div>
    <div class="toolbar actions"><button class="btn primary" id="saveWl">💾 관찰 종목 저장</button><span class="muted">✕ 로 지운 뒤 저장하면 목록에서 빠져요</span></div>`;
  const g = noteGrid(container.querySelector("#wg"), rows, false, true, true);
  container.querySelector("#wlForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    busy(e.target.querySelector("button[type=submit]"), "⏳", async () => {
      const r = await api("/api/watchlist", { method: "POST", body: JSON.stringify({ 종목: f.get("종목"), 심볼: f.get("심볼"), 통화: f.get("통화") }) });
      toast(r.status === "added" ? `✅ '${f.get("종목")}' 등록 — 현재가는 10분 안에 붙어요` : `⚠️ 이미 관찰 중이라 심볼만 바꿨어요`);
      await ctx.afterSave(true);
    });
  });
  container.querySelector("#saveWl").addEventListener("click", (e) => busy(e.currentTarget, "⏳ 저장 중", async () => {
    const r = await api("/api/watchlist", { method: "PUT", body: JSON.stringify({ rows: g.rows }) });
    toast(`✅ 관찰 종목 ${r.rows}개 저장`);
    await ctx.afterSave(true);
  }));
}

// =====================================================================
// ↕ 순서 편집
// =====================================================================
export function orderEditor(container, holdings, ctx) {
  const list = holdings.map((h) => h.종목);
  const draw = () => {
    container.innerHTML = `<div class="card order">
      <p class="caption" style="margin:0 0 8px">위·아래로 옮긴 뒤 저장하면 이 순서대로 보여요.</p>
      ${list.map((t, i) => `<div class="order-row"><span class="idx">${i + 1}</span><span class="name">${esc(t)}</span>
        <button class="btn ghost sm" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="위로">▲</button>
        <button class="btn ghost sm" data-down="${i}" ${i === list.length - 1 ? "disabled" : ""} aria-label="아래로">▼</button></div>`).join("")}
      <div class="toolbar actions"><button class="btn primary" id="saveOrder">💾 순서 저장</button><button class="btn ghost" id="cancelOrder">닫기</button></div>
    </div>`;
    container.querySelectorAll("[data-up]").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.up; [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); }));
    container.querySelectorAll("[data-down]").forEach((b) => b.addEventListener("click", () => { const i = +b.dataset.down; [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); }));
    container.querySelector("#cancelOrder").addEventListener("click", () => { container.innerHTML = ""; });
    container.querySelector("#saveOrder").addEventListener("click", (e) => busy(e.currentTarget, "⏳ 저장 중", async () => {
      const order = Object.fromEntries(list.map((t, i) => [t, i]));
      await api("/api/order", { method: "PUT", body: JSON.stringify({ order }) });
      toast(`✅ ${list.length}개 종목 순서 저장`);
      container.innerHTML = "";
      await ctx.afterSave(true);
    }));
  };
  draw();
}

// =====================================================================
// ⚙️ 설정
// =====================================================================
export async function renderSettings(v, ctx) {
  const tok = v.dataset.tok;
  v.innerHTML = `<div class="skeleton">불러오는 중…</div>`;
  let d;
  try { d = await api("/api/settings"); } catch (e) { v.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; return; }
  if (v.dataset.tok !== tok) return; // 그새 다른 탭으로 감
  v.innerHTML = `
    <div class="section"><h2>☁️ 구글 시트</h2>
      <div class="card"><a href="https://docs.google.com/spreadsheets/d/${esc(d.sheetId)}" target="_blank" rel="noopener">시트 열기 ↗</a>
      <p class="caption">시트를 직접 고쳐도 돼요. 웹에는 1분 안에 반영되고, 바로 보려면 위의 🔄 새로고침을 눌러요.</p></div>
    </div>
    <div class="section"><h2>🏷 카테고리 <span class="sub">종목 → 카테고리 (비중 묶음)</span></h2>
      <div id="catGrid"></div>
      <div class="toolbar actions"><button class="btn ghost" id="addCat">＋ 행 추가</button><button class="btn primary" id="saveCat">💾 카테고리 저장</button></div>
    </div>
    <div class="section"><h2>📈 시세 심볼 <span class="sub">종목 → yfinance 표기 · 출처는 자동 (한·미·일 = 네이버, 유럽 등 = Yahoo)</span></h2>
      <div id="tmGrid"></div>
      <div class="toolbar actions"><button class="btn ghost" id="addTm">＋ 행 추가</button><button class="btn primary" id="saveTm">💾 심볼 저장</button></div>
    </div>`;
  const cg = editGrid(v.querySelector("#catGrid"), [
    { key: "종목", label: "종목", type: "text", width: 140 },
    { key: "카테고리", label: "카테고리", type: "text", width: 140 },
  ], d.categories, { deletable: true });
  const tg = editGrid(v.querySelector("#tmGrid"), [
    { key: "종목", label: "종목", type: "text", width: 140 },
    { key: "심볼", label: "심볼", type: "text", width: 120 },
    { key: "출처", label: "지금 출처", type: "ro" },
    { key: "시세", label: "최근 시세", type: "ro", align: "r", fmt: (x) => (isNum(x) ? x.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : "-") },
    { key: "네이버코드", label: "네이버 코드", type: "ro" },
  ], d.tickers, { deletable: true });
  v.querySelector("#addCat").addEventListener("click", () => cg.add({ 종목: "", 카테고리: "" }));
  v.querySelector("#addTm").addEventListener("click", () => tg.add({ 종목: "", 심볼: "" }));
  v.querySelector("#saveCat").addEventListener("click", (e) => busy(e.currentTarget, "⏳", async () => {
    const r = await api("/api/categories", { method: "PUT", body: JSON.stringify({ rows: cg.rows }) });
    toast(`✅ 카테고리 ${r.rows}개 저장`); await ctx.afterSave(); renderSettings(v, ctx);
  }));
  v.querySelector("#saveTm").addEventListener("click", (e) => busy(e.currentTarget, "⏳", async () => {
    const r = await api("/api/tickers", { method: "PUT", body: JSON.stringify({ rows: tg.rows }) });
    toast(`✅ 심볼 ${r.rows}개 저장 — 새 심볼 시세는 10분 안에 붙어요`); await ctx.afterSave(); renderSettings(v, ctx);
  }));
}
