import { lineChart, barList, donut } from "./charts.js";
import { esc, isNum, store, fmt, signCls, api } from "./util.js";
import { renderSnapshots, renderFlows, renderSettings, notesEditor, watchlistEditor, orderEditor } from "./edit.js";

// ---------- 공통 ----------
const $app = document.getElementById("app");

// ---------- 상태 ----------
const S = { me: null, data: null, nav: null, tab: store.get("tab", "port"), blur: store.get("blur", false), range: store.get("range", "all"), showTotal: store.get("showTotal", true) };

// ---------- 로그인 ----------
async function showLogin(msg = "") {
  const list = await api("/api/portfolios").catch(() => []);
  let pid = store.get("pid", list[0]?.id);
  $app.innerHTML = `
    <div class="login"><form class="card" id="lf">
      <h1>📊 포트폴리오 모니터</h1>
      <p>포트폴리오를 고르고 비밀번호를 입력해 주세요.</p>
      <label>포트폴리오</label>
      <div class="seg" role="group">${list.map((p) => `<button type="button" data-pid="${esc(p.id)}" aria-pressed="${p.id === pid}">${esc(p.name)}</button>`).join("")}</div>
      <label for="pw">비밀번호</label>
      <input id="pw" type="password" autocomplete="current-password" required autofocus>
      <button class="btn-primary" type="submit">들어가기</button>
      <div class="error" id="lerr">${esc(msg)}</div>
    </form></div>`;
  $app.querySelectorAll("[data-pid]").forEach((b) => b.addEventListener("click", () => {
    pid = b.dataset.pid;
    $app.querySelectorAll("[data-pid]").forEach((x) => x.setAttribute("aria-pressed", x === b));
  }));
  document.getElementById("lf").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ pid, password: document.getElementById("pw").value }) });
      store.set("pid", pid);
      boot();
    } catch (err) {
      document.getElementById("lerr").textContent = err.message;
      btn.disabled = false;
    }
  });
}

// ---------- 뼈대 ----------
const TABS_ADMIN = [["port", "💼 현재 포트폴리오"], ["snap", "📸 스냅샷"], ["flows", "💸 자금 흐름"], ["nav", "📈 자산 추이"], ["notes", "🎯 종목 메모"], ["settings", "⚙️ 설정"]];
const TABS_GUEST = [["port", "💼 현재 포트폴리오"], ["notes", "🎯 종목 메모"]];

function shell() {
  const admin = S.me.role === "admin";
  const tabs = admin ? TABS_ADMIN : TABS_GUEST;
  if (!tabs.some(([k]) => k === S.tab)) S.tab = "port";
  $app.innerHTML = `
    <header class="topbar"><div class="wrap">
      <div class="brand">📊 ${esc(S.me.name)}의 포트폴리오 <span class="badge">${admin ? "👑 관리자" : "👀 게스트"}</span></div>
      ${admin ? `<button class="icon-btn" id="refresh" title="시트와 시세를 지금 다시 불러와요">🔄 새로고침</button>` : ""}
      <button class="icon-btn" id="logout">로그아웃</button>
      <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button class="tab" role="tab" data-tab="${k}" aria-selected="${k === S.tab}">${l}</button>`).join("")}</nav>
    </div></header>
    <section class="hero-band"><div class="wrap" id="summary"></div></section>
    <main class="wrap">
      <section id="view"></section>
    </main>`;
  $app.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
    S.tab = b.dataset.tab; store.set("tab", S.tab);
    $app.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", x === b));
    renderView();
  }));
  document.getElementById("logout").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); showLogin(); });
  document.getElementById("refresh")?.addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "⏳ 불러오는 중";
    try { await api("/api/refresh", { method: "POST" }); S.nav = null; await loadData(); }
    catch (err) { alert(err.message); }
    b.disabled = false; b.textContent = "🔄 새로고침";
  });
}

const EDIT_TABS = new Set(["snap", "flows", "settings"]);

async function loadData(silent = false) {
  const d = await api("/api/portfolio");
  S.data = d;
  renderSummary();
  // 편집 탭은 입력 중일 수 있어서 조용한 재조회 때 다시 그리지 않는다
  if (!silent || (S.tab !== "nav" && !EDIT_TABS.has(S.tab))) renderView();
  if (d.stale && !silent) setTimeout(() => loadData(true).catch(() => {}), 2500); // 뒤에서 새로 받은 시트로 한 번 더
}

/** 저장 후: 요약·자산 추이 캐시 갱신 (rerender=true 면 지금 탭도 다시 그림) */
const ctx = {
  async afterSave(rerender = false) {
    S.nav = null;
    S.data = await api("/api/portfolio");
    renderSummary();
    if (rerender) renderView();
  },
};

// ---------- 요약 ----------
function renderSummary() {
  const d = S.data, admin = S.me.role === "admin";
  const el = document.getElementById("summary");
  const t = d.totals;
  // 밤색 히어로 띠: 큰 숫자 하나 + 옆에 작은 정보들 (Mercury stat-block)
  const arrow = (v) => (isNum(v) ? (v > 0 ? "▲" : v < 0 ? "▼" : "") : "");
  const held = d.holdings.filter((h) => !isCash(h)).length;
  el.innerHTML = `
    <div class="hero-grid">
      <div class="hero-main">
        <div class="eyebrow">총 평가액</div>
        <div class="stat">${t ? fmt.krw(t.평가액) : "•••"}</div>
        ${t ? `<div class="hero-delta">
            <span class="delta-pill ${signCls(t.수익률)}">${arrow(t.수익률)} ${fmt.pct(t.수익률)}</span>
            <span>평가 손익 <b class="${signCls(t.평가손익)}">${fmt.krw(t.평가손익)}</b></span>
            <span class="dim">원가 ${fmt.krw(t.원가)}</span>
          </div>` : `<div class="hero-delta"><span class="dim">게스트 보기 — 금액은 가려져 있어요</span></div>`}
      </div>
      <dl class="hero-side">
        <div><dt>최근 스냅샷</dt><dd>${esc(d.latestSnapshot || "—")}</dd></div>
        <div><dt>보유 종목</dt><dd>${held}개 <small>현금·연금 제외</small></dd></div>
        ${admin ? `<div><dt>환율</dt><dd>$ ${fmt.num(d.fx?.USD, 1)} <small>€ ${fmt.num(d.fx?.EUR, 1)} · ¥ ${fmt.num(d.fx?.JPY, 2)}</small></dd></div>
        <div><dt>시세</dt><dd>${fmt.time(d.pricesAt)} <small>10분마다 갱신</small></dd></div>` : ""}
      </dl>
    </div>
    ${d.warnings?.length ? `<div class="hero-note">⚠️ 현재가를 못 받은 종목: ${d.warnings.map((w) => `<b>${esc(w.종목)}</b> (${w.출처 === "snapshot" ? "스냅샷 가격 사용" : "가격 없음"})`).join(", ")}</div>` : ""}
    ${!d.latestSnapshot ? `<div class="hero-note">스냅샷이 없어요.</div>` : ""}`;
}

// ---------- 탭 ----------
function renderView() {
  const v = document.getElementById("view");
  v.dataset.tok = String(Math.random()); // 늦게 도착한 이전 탭 응답이 화면을 덮지 않게
  if (!S.data) { v.innerHTML = `<div class="skeleton">불러오는 중…</div>`; return; }
  if (S.tab === "port") renderPortfolio(v);
  else if (S.tab === "nav") renderNav(v);
  else if (S.tab === "notes") renderNotes(v);
  else if (S.tab === "snap") renderSnapshots(v, ctx);
  else if (S.tab === "flows") renderFlows(v, ctx);
  else if (S.tab === "settings") renderSettings(v, ctx);
}

const isCash = (r) => r.평균단가 == null && !isNum(r.수익률);
const srcTag = (r) => (r.가격출처 === "snapshot" ? `<span class="src-tag">스냅샷가</span>` : r.가격출처 === "missing" ? `<span class="src-tag">가격없음</span>` : "");

/** 폰용 한 줄 카드 (표와 같은 데이터) */
function holdingCard(r, admin, B) {
  const right = admin ? B(fmt.won(r.평가액)) : (isNum(r.비중) ? (r.비중 * 100).toFixed(1) + "%" : "-");
  let sub = esc(r.카테고리);
  if (!isCash(r)) sub += ` · ${fmt.price(r.현재가, r.통화)} ${esc(r.통화)}`;
  if (admin && isNum(r.수량) && !isCash(r)) sub += ` · ${B(fmt.qty(r.수량) + "주")}`;
  const pct = isNum(r.수익률)
    ? `<div class="h-pct ${signCls(r.수익률)}">${fmt.pct(r.수익률)}${admin && isNum(r.평가손익) ? " · " + B(fmt.krw(r.평가손익)) : ""}</div>`
    : "";
  return `<div class="hcard">
    <div class="h-l"><div class="h-name">${esc(r.종목)}${srcTag(r)}</div><div class="h-sub">${sub}</div></div>
    <div class="h-r"><div class="h-val">${right}</div>${pct}</div>
  </div>`;
}

function renderPortfolio(v) {
  const d = S.data, admin = S.me.role === "admin";
  const blur = !admin || S.blur;
  const B = (html) => (blur && admin ? `<span class="blurred">${html}</span>` : html);
  const rows = d.holdings;
  v.innerHTML = `
    <div class="section port-top">
    <div class="port-table">
      <h2>보유 종목 <span class="sub">${rows.length}개</span>
        ${admin ? `<span style="margin-left:auto;display:inline-flex;gap:10px;align-items:center"><button class="btn ghost sm" id="orderBtn">↕ 순서 편집</button><label class="toggle"><input type="checkbox" id="blur" ${S.blur ? "checked" : ""}> 🔒 금액 가리기</label></span>` : `<span class="sub" style="margin-left:auto">🔒 게스트 보기 (금액 숨김)</span>`}
      </h2>
      <div id="orderBox"></div>
      <div class="table-wrap has-cards"><table class="data">
        <thead><tr>
          <th class="l sticky">종목</th><th class="l">카테고리</th><th class="l">통화 · 환율</th>
          ${admin ? "<th>수량</th>" : ""}<th>평균단가</th><th>현재가</th>${admin ? "<th>평가액</th><th>평가손익</th>" : "<th>비중</th>"}<th>수익률</th>
        </tr></thead>
        <tbody>${rows.map((r) => `<tr>
          <td class="l sticky">${esc(r.종목)}${srcTag(r)}</td>
          <td class="l">${esc(r.카테고리)}</td><td class="l">${esc(r.통화)}${isNum(r.환율) ? ` <span class="muted">· ${fmt.num(r.환율, 2)}</span>` : ""}</td>
          ${admin ? `<td>${isNum(r.수량) ? B(fmt.qty(r.수량)) : ""}</td>` : ""}
          <td>${fmt.price(r.평균단가, r.통화) === "-" ? "" : fmt.price(r.평균단가, r.통화)}</td>
          <td>${isCash(r) ? "" : fmt.price(r.현재가, r.통화)}</td>
          ${admin ? `<td>${B(fmt.won(r.평가액))}</td><td class="${signCls(r.평가손익)}">${isNum(r.평가손익) ? B(fmt.won(r.평가손익)) : ""}</td>` : `<td>${isNum(r.비중) ? (r.비중 * 100).toFixed(1) + "%" : "-"}</td>`}
          <td class="${signCls(r.수익률)}">${isNum(r.수익률) ? fmt.pct(r.수익률) : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>
      <div class="cards-mobile">${rows.map((r) => holdingCard(r, admin, B)).join("")}</div>
    </div>
    <div class="port-donut"><h2>카테고리 비중</h2><div class="card donut-card" id="cats"></div></div>
    </div>
    <div class="section"><h2>종목별 비중 <span class="sub">상위 15개 · 현금은 묶어서</span></h2><div class="card" id="bars"></div></div>`;
  document.getElementById("blur")?.addEventListener("change", (e) => { S.blur = e.target.checked; store.set("blur", S.blur); renderPortfolio(v); });
  document.getElementById("orderBtn")?.addEventListener("click", () => orderEditor(document.getElementById("orderBox"), rows, ctx));
  const showWon = admin && !S.blur;
  barList(document.getElementById("bars"), d.bars.map((b) => ({ name: b.종목, frac: b.비중, label: `${(b.비중 * 100).toFixed(1)}%`, sub: showWon ? fmt.krw(b.평가액) : "" })));
  donut(document.getElementById("cats"), d.categories.map((c) => ({ name: c.카테고리, frac: c.비중, won: showWon ? c.평가액 : null })), {
    center: `${d.categories.length}개`,
    centerSub: "카테고리",
    fmtWon: fmt.krw,
    inside: true,      // Streamlit 처럼 조각 안에 이름 + %
    size: 340,
  });
}

// ---------- 자산 추이 ----------
const RANGES = [["1m", "1개월"], ["3m", "3개월"], ["6m", "6개월"], ["ytd", "올해"], ["1y", "1년"], ["all", "전체"]];
function rangeStart(key, last) {
  const d = new Date(last + "T00:00:00Z");
  if (key === "ytd") return `${last.slice(0, 4)}-01-01`;
  const months = { "1m": 1, "3m": 3, "6m": 6, "1y": 12 }[key];
  if (!months) return "0000-00-00";
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function drawdown(rows, col) {
  const pts = rows.filter((r) => r[col] > 0);
  if (pts.length < 2) return null;
  let peak = -Infinity, peakAll = 0, mdd = 0, mddPeak = null, mddTrough = null, curPeak = null;
  const series = [];
  for (const r of pts) {
    if (r[col] > peak) { peak = r[col]; curPeak = r; }
    const dd = r[col] / peak - 1;
    series.push([r.날짜, dd * 100]);
    if (dd < mdd) { mdd = dd; mddTrough = r; mddPeak = curPeak; }
  }
  const top = pts.reduce((a, b) => (b[col] > a[col] ? b : a), pts[0]);
  const last = pts[pts.length - 1];
  return { mdd, mddPeak, mddTrough, cur: last[col] / top[col] - 1, top, last, series, col };
}

async function renderNav(v) {
  if (!S.nav) {
    v.innerHTML = `<div class="skeleton">자산 추이 계산 중…</div>`;
    try { S.nav = await api("/api/nav"); } catch (e) { v.innerHTML = `<div class="notice err">${esc(e.message)}</div>`; return; }
    if (S.tab !== "nav") return;
  }
  const N = S.nav;
  const all = N.nav;
  if (!all.length) { v.innerHTML = `<div class="empty">스냅샷이나 anchor 가 없어서 자산 추이를 그릴 수 없어요.</div>`; return; }
  const lastDate = all[all.length - 1].날짜;
  const from = rangeStart(S.range, lastDate);
  const rows = all.filter((r) => r.날짜 >= from);
  const first = rows[0], last = rows[rows.length - 1];
  const delta = last.순자산 - first.순자산;
  const flowsIn = N.flows.filter((f) => f.날짜 > first.날짜 && f.날짜 <= last.날짜).reduce((s, f) => s + f.krw, 0);
  const income = last.순자산 - first.순자산 - flowsIn; // 이 기간 금융수익금 (파이썬 compute_income_summary 와 같은 식)
  const inc = N.income;
  const ddN = drawdown(rows, "순자산"), ddT = drawdown(rows, "총자산");
  const unit = rows.filter((r) => r.기준가_총자산 > 0);
  const u0 = unit[0], u1 = unit[unit.length - 1];
  const yStart = `${lastDate.slice(0, 4)}-01-01`;
  const ya = [...all].reverse().find((r) => r.날짜 < yStart && r.기준가_총자산 > 0);
  const year = lastDate.slice(0, 4);

  v.innerHTML = `
    <div class="section" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div class="seg" role="group" aria-label="기간">${RANGES.map(([k, l]) => `<button data-range="${k}" aria-pressed="${k === S.range}">${l}</button>`).join("")}</div>
      <label class="toggle"><input type="checkbox" id="showTotal" ${S.showTotal ? "checked" : ""}> 총자산 함께 보기</label>
      <span class="muted" style="font-size:13px">${first.날짜} ~ ${last.날짜} · 영업일 ${rows.length}일</span>
    </div>
    ${N.missingHist?.length ? `<div class="notice warn">가격 이력을 아직 못 받은 종목: ${N.missingHist.map(esc).join(", ")} — 10분마다 크론이 채워요. 그 전까지 이 종목은 평균단가로 계산돼요.</div>` : ""}

    <div class="section"><h2>순자산 추이</h2><div class="card"><div id="c-nav"></div></div></div>
    <div class="section metrics">
      <div class="metric"><div class="label">시작 (${first.날짜})</div><div class="value">${fmt.krw(first.순자산)}</div></div>
      <div class="metric"><div class="label">현재 (${last.날짜})</div><div class="value">${fmt.krw(last.순자산)}</div></div>
      <div class="metric"><div class="label">순자산 증감</div><div class="value ${signCls(delta)}">${fmt.krw(delta)}</div><div class="delta ${signCls(delta)}">${fmt.pct(first.순자산 ? last.순자산 / first.순자산 - 1 : null)}</div></div>
      <div class="metric"><div class="label">스냅샷 수</div><div class="value">${N.snapshotCount}</div></div>
    </div>

    <div class="section"><h2>💰 금융수익금 <span class="sub">순자산 기준 · 외부 자금 흐름 제외</span></h2>
      <div class="metrics">
        <div class="metric hero"><div class="label">이 기간 금융수익금</div><div class="value ${signCls(income)}">${fmt.krw(income)}</div><div class="delta ${signCls(income)}">${fmt.pct(first.순자산 ? income / first.순자산 : null)}</div></div>
        <div class="metric"><div class="label">${inc.year ?? year} YTD 금융수익금</div><div class="value ${signCls(inc.ytd_income)}">${inc.ytd_income == null ? "—" : fmt.krw(inc.ytd_income)}</div>${inc.ytd_income != null && inc.year_anchor_nav_net ? `<div class="delta ${signCls(inc.ytd_income)}">${fmt.pct(inc.ytd_income / inc.year_anchor_nav_net)}</div>` : ""}</div>
        <div class="metric"><div class="label">기간 외부 유입</div><div class="value">${fmt.krw(flowsIn)}</div></div>
        <div class="metric"><div class="label">현재 부채</div><div class="value">${fmt.krw(last.부채)}</div></div>
      </div>
      <p class="caption">금융수익금 = 기간 끝 순자산 − 시작 순자산 − 그 사이 외부 유입. YTD 기준점: ${esc(inc.year_anchor_date || "—")} (순자산 ${fmt.krw(inc.year_anchor_nav_net)}).</p>
    </div>

    <div class="section"><h2>📉 낙폭 <span class="sub">MDD = 기간 내 고점 대비 최대 하락 · 현재 낙폭 = 기간 내 최고점 대비 지금</span></h2>
      <div class="metrics">
        ${ddN ? `<div class="metric"><div class="label">MDD (순자산)</div><div class="value down">${fmt.pct(ddN.mdd)}</div><div class="delta muted">${ddN.mddPeak?.날짜 ?? ""} → ${ddN.mddTrough?.날짜 ?? ""}</div></div>
        <div class="metric"><div class="label">현재 낙폭 (순자산)</div><div class="value ${ddN.cur < 0 ? "down" : ""}">${fmt.pct(ddN.cur)}</div><div class="delta muted">전고점 ${ddN.top.날짜}</div></div>` : ""}
        ${ddT ? `<div class="metric"><div class="label">MDD (총자산)</div><div class="value down">${fmt.pct(ddT.mdd)}</div><div class="delta muted">${ddT.mddPeak?.날짜 ?? ""} → ${ddT.mddTrough?.날짜 ?? ""}</div></div>
        <div class="metric"><div class="label">현재 낙폭 (총자산)</div><div class="value ${ddT.cur < 0 ? "down" : ""}">${fmt.pct(ddT.cur)}</div><div class="delta muted">전고점 ${ddT.top.날짜}</div></div>` : ""}
      </div>
      <div class="card" style="margin-top:10px"><div id="c-dd"></div></div>
    </div>

    ${unit.length >= 2 ? `<div class="section"><h2>📈 기준가 <span class="sub">외부 자금 흐름에 영향받지 않는 운용 성과 · 2024-12-24 = 1000</span></h2>
      <div class="card"><div id="c-unit"></div></div>
      <div class="metrics" style="margin-top:10px">
        <div class="metric"><div class="label">총 기준가 (현재)</div><div class="value">${fmt.num(u1.기준가_총자산)}</div><div class="delta ${signCls(u1.기준가_총자산 / u0.기준가_총자산 - 1)}">${fmt.pct(u1.기준가_총자산 / u0.기준가_총자산 - 1)}</div></div>
        <div class="metric"><div class="label">순 기준가 (현재)</div><div class="value">${fmt.num(u1.기준가_순자산)}</div>${u0.기준가_순자산 > 0 ? `<div class="delta ${signCls(u1.기준가_순자산 / u0.기준가_순자산 - 1)}">${fmt.pct(u1.기준가_순자산 / u0.기준가_순자산 - 1)}</div>` : ""}</div>
        ${ya ? `<div class="metric"><div class="label">${year} YTD 총 기준가</div><div class="value ${signCls(u1.기준가_총자산 / ya.기준가_총자산 - 1)}">${fmt.pct(u1.기준가_총자산 / ya.기준가_총자산 - 1)}</div><div class="delta muted">${ya.날짜} ${fmt.num(ya.기준가_총자산)} 대비</div></div>
        ${ya.기준가_순자산 > 0 ? `<div class="metric"><div class="label">${year} YTD 순 기준가</div><div class="value ${signCls(u1.기준가_순자산 / ya.기준가_순자산 - 1)}">${fmt.pct(u1.기준가_순자산 / ya.기준가_순자산 - 1)}</div><div class="delta muted">${ya.날짜} ${fmt.num(ya.기준가_순자산)} 대비</div></div>` : ""}` : ""}
      </div>
    </div>` : ""}

    <div class="section"><h2>🧮 좌수 <span class="sub">외부 자금이 들어오면 늘고 나가면 줄어요 (운용 손익으로는 안 바뀜)</span></h2>
      <div class="card"><div id="c-units"></div></div>
      <div class="metrics" style="margin-top:10px">
        <div class="metric"><div class="label">좌수 총 (현재)</div><div class="value">${fmt.num(last.좌수_총)}</div><div class="delta muted">${(last.좌수_총 - first.좌수_총 >= 0 ? "+" : "") + fmt.num(last.좌수_총 - first.좌수_총)}</div></div>
        <div class="metric"><div class="label">좌수 순 (현재)</div><div class="value">${fmt.num(last.좌수_순)}</div><div class="delta muted">${(last.좌수_순 - first.좌수_순 >= 0 ? "+" : "") + fmt.num(last.좌수_순 - first.좌수_순)}</div></div>
      </div>
    </div>

    <details class="more"><summary>📋 일별 데이터 (${rows.length}행)</summary>
      <div class="table-wrap" style="max-height:480px;margin-top:8px"><table class="data">
        <thead><tr><th class="l sticky">날짜</th><th>총자산</th><th>순자산</th><th>부채</th><th>외부유입_총</th><th>외부유입_순</th><th>좌수_총</th><th>좌수_순</th><th>기준가_총</th><th>기준가_순</th></tr></thead>
        <tbody>${[...rows].reverse().map((r) => `<tr><td class="l sticky">${r.날짜}</td><td>${fmt.won(r.총자산)}</td><td>${fmt.won(r.순자산)}</td><td>${fmt.won(r.부채)}</td><td>${r.외부유입_총 ? fmt.won(r.외부유입_총) : ""}</td><td>${r.외부유입_순 ? fmt.won(r.외부유입_순) : ""}</td><td>${fmt.num(r.좌수_총, 4)}</td><td>${fmt.num(r.좌수_순, 4)}</td><td>${fmt.num(r.기준가_총자산)}</td><td>${fmt.num(r.기준가_순자산)}</td></tr>`).join("")}</tbody>
      </table></div>
    </details>
    ${N.debt.length ? `<details class="more"><summary>💸 부채 이력 (${N.debt.length}건)</summary>
      <div class="table-wrap" style="margin-top:8px"><table class="data"><thead><tr><th class="l">날짜</th><th>부채</th><th class="l">메모</th></tr></thead>
      <tbody>${N.debt.map((r) => `<tr><td class="l">${r.날짜}</td><td>${fmt.won(r.부채)}</td><td class="l">${esc(r.메모)}</td></tr>`).join("")}</tbody></table></div>
    </details>` : ""}`;

  v.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => { S.range = b.dataset.range; store.set("range", S.range); renderNav(v); }));
  document.getElementById("showTotal").addEventListener("change", (e) => { S.showTotal = e.target.checked; store.set("showTotal", S.showTotal); renderNav(v); });

  const navSeries = [{ name: "순자산", color: "var(--series-1)", fill: "var(--series-1-fill)", points: rows.map((r) => [r.날짜, r.순자산]) }];
  if (S.showTotal) navSeries.push({ name: "총자산", color: "var(--series-2)", dash: true, points: rows.map((r) => [r.날짜, r.총자산]) });
  const anchorsIn = N.anchors.filter((a) => a.날짜 >= first.날짜 && a.날짜 <= last.날짜 && isNum(a.순자산));
  lineChart(document.getElementById("c-nav"), {
    series: navSeries, height: 320,
    markers: anchorsIn.length ? { name: "수동 기록(anchor)", color: "var(--series-1)", points: anchorsIn.map((a) => [a.날짜, a.순자산]) } : null,
    yFormat: fmt.axisKrw, tipFormat: fmt.krw,
  });
  const ddSeries = [];
  if (ddN) ddSeries.push({ name: "순자산 낙폭", color: "var(--series-1)", fill: "var(--series-1-fill)", points: ddN.series });
  if (ddT) ddSeries.push({ name: "총자산 낙폭", color: "var(--series-2)", dash: true, points: ddT.series });
  if (ddSeries.length) lineChart(document.getElementById("c-dd"), { series: ddSeries, height: 200, includeZero: true, yFormat: (x) => `${+x.toFixed(1)}%`, tipFormat: (x) => `${x.toFixed(2)}%` });
  if (unit.length >= 2) {
    const us = [{ name: "총자산 기준가", color: "var(--series-2)", points: unit.map((r) => [r.날짜, r.기준가_총자산]) }];
    if (unit.some((r) => r.기준가_순자산 > 0)) us.unshift({ name: "순자산 기준가", color: "var(--series-1)", points: unit.map((r) => [r.날짜, r.기준가_순자산 > 0 ? r.기준가_순자산 : NaN]) });
    lineChart(document.getElementById("c-unit"), { series: us, height: 260, ref: { y: 1000, label: "시작 1000" }, yFormat: (x) => x.toLocaleString("ko-KR"), tipFormat: (x) => fmt.num(x) });
  }
  lineChart(document.getElementById("c-units"), {
    series: [
      { name: "좌수 (순자산)", color: "var(--series-1)", step: true, points: rows.map((r) => [r.날짜, r.좌수_순]) },
      { name: "좌수 (총자산)", color: "var(--series-2)", step: true, dash: true, points: rows.map((r) => [r.날짜, r.좌수_총]) },
    ],
    height: 220, yFormat: (x) => Math.round(x).toLocaleString("ko-KR"), tipFormat: (x) => fmt.num(x),
  });
}

// ---------- 종목 메모 ----------
function notesTable(rows, withAvg, symbolCol) {
  if (!rows.length) return `<div class="empty">없어요</div>`;
  return `<div class="table-wrap"><table class="data">
    <thead><tr><th class="l sticky">종목</th>${symbolCol ? `<th class="l">심볼</th>` : `<th class="l">카테고리</th>`}<th class="l">통화</th>${withAvg ? "<th>평균단가</th>" : ""}<th>현재가</th>
      <th>🎯 목표가(상단)</th><th>업사이드</th><th>🛡️ 목표가(하단)</th><th>다운사이드</th><th>R/R</th><th class="l">📈 업사이드 메모</th><th class="l">📉 다운사이드 메모</th><th class="l">업데이트</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="l sticky">${esc(r.종목)}</td>${symbolCol ? `<td class="l">${esc(r.심볼)}</td>` : `<td class="l">${esc(r.카테고리)}</td>`}<td class="l">${esc(r.통화)}</td>
      ${withAvg ? `<td>${fmt.price(r.평균단가, r.통화)}</td>` : ""}<td>${fmt.price(r.현재가, r.통화)}</td>
      <td>${fmt.price(r.목표가_상단, r.통화)}</td><td class="${signCls(r.업사이드_pct)}">${fmt.pctRaw(r.업사이드_pct)}</td>
      <td>${fmt.price(r.목표가_하단, r.통화)}</td><td class="${signCls(r.다운사이드_pct)}">${fmt.pctRaw(r.다운사이드_pct)}</td>
      <td>${isNum(r.RR) ? r.RR.toFixed(2) : "-"}</td>
      <td class="memo">${esc(r.업사이드_메모)}</td><td class="memo">${esc(r.다운사이드_메모)}</td><td class="l muted">${esc(r.업데이트일)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

function renderNotes(v) {
  const d = S.data, admin = S.me.role === "admin";
  v.innerHTML = `
    <div class="section"><h2>📦 보유 종목 <span class="sub">목표가와 메모 · 팔고 나면 자동으로 숨겨져요</span></h2><div id="notesBox">${admin ? "" : notesTable(d.notes, true, false)}</div></div>
    <div class="section"><h2>👁️ 관찰 종목 <span class="sub">갖고 있진 않지만 지켜보는 종목</span></h2><div id="wlBox">${admin ? "" : notesTable(d.watchlist, false, true)}</div></div>`;
  if (admin) {
    if (d.notes.length) notesEditor(document.getElementById("notesBox"), d.notes, ctx);
    else document.getElementById("notesBox").innerHTML = `<div class="empty">보유 종목이 없어요</div>`;
    watchlistEditor(document.getElementById("wlBox"), d.watchlist, ctx);
  }
}

// ---------- 시작 ----------
async function boot() {
  try {
    S.me = await api("/api/me");
  } catch (e) {
    if (e.status === 401) return showLogin();
    $app.innerHTML = `<div class="wrap"><div class="notice err">${esc(e.message)}</div></div>`;
    return;
  }
  S.data = null; S.nav = null;
  shell();
  renderView();
  try { await loadData(); }
  catch (e) {
    if (e.status === 401) return showLogin();
    document.getElementById("view").innerHTML = `<div class="notice err">${esc(e.message)}</div>`;
  }
}
boot();
