// 가벼운 SVG 선 차트 (라이브러리 없이). 십자선 + 툴팁, 화면 폭에 맞춰 다시 그림.
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};
const t = (d) => Date.parse(d + "T00:00:00Z");

function niceTicks(min, max, count = 5) {
  if (!(max > min)) { const pad = Math.abs(min) * 0.05 || 1; min -= pad; max += pad; }
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi, ticks };
}

function dateTicks(x0, x1, maxTicks) {
  const days = (x1 - x0) / 864e5;
  const out = [];
  const d = new Date(x0);
  if (days > 500) {               // 분기·반기
    const stepM = days > 1400 ? 12 : 6;
    d.setUTCDate(1); d.setUTCMonth(Math.ceil(d.getUTCMonth() / stepM) * stepM);
    while (d.getTime() <= x1) { if (d.getTime() >= x0) out.push(d.getTime()); d.setUTCMonth(d.getUTCMonth() + stepM); }
  } else if (days > 75) {         // 월
    const stepM = days > 300 ? 2 : 1;
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
    while (d.getTime() <= x1) { out.push(d.getTime()); d.setUTCMonth(d.getUTCMonth() + stepM); }
  } else {                        // 주
    const step = days > 30 ? 14 : 7;
    while (d.getTime() <= x1) { out.push(d.getTime()); d.setUTCDate(d.getUTCDate() + step); }
  }
  while (out.length > maxTicks) for (let i = out.length - 2; i > 0; i -= 2) out.splice(i, 1);
  return { ticks: out, fmt: days > 75 ? (ms) => { const z = new Date(ms); return `${String(z.getUTCFullYear()).slice(2)}.${String(z.getUTCMonth() + 1).padStart(2, "0")}`; }
                                     : (ms) => { const z = new Date(ms); return `${z.getUTCMonth() + 1}/${z.getUTCDate()}`; } };
}

/**
 * opts: {
 *   series: [{name, color:"var(--series-1)", points:[[YYYY-MM-DD, v]], dash?, step?, fill?, width?}],
 *   markers?: {name, color, points},
 *   ref?: {y, label},
 *   height?, yFormat(v), tipFormat(v), includeZero?
 * }
 */
export function lineChart(container, opts) {
  container.innerHTML = "";
  container.classList.add("chart-host");
  const many = opts.series.length + (opts.markers ? 1 : 0) > 1;
  if (many) {
    const lg = document.createElement("div");
    lg.className = "legend";
    for (const s of opts.series) {
      lg.insertAdjacentHTML("beforeend", `<span class="key"><span class="sw ${s.dash ? "dash" : ""}" style="border-color:${s.color}"></span>${s.name}</span>`);
    }
    if (opts.markers) lg.insertAdjacentHTML("beforeend", `<span class="key"><span class="sw dot" style="background:${opts.markers.color}"></span>${opts.markers.name}</span>`);
    container.appendChild(lg);
  }
  const box = document.createElement("div");
  box.className = "chart";
  container.appendChild(box);
  const tip = document.createElement("div");
  tip.className = "tooltip"; tip.hidden = true;
  box.appendChild(tip);

  const height = opts.height || 280;
  const yFmt = opts.yFormat || ((v) => v.toLocaleString("ko-KR"));
  const tipFmt = opts.tipFormat || yFmt;
  const base = opts.series[0].points;
  const lookups = opts.series.map((s) => new Map(s.points));

  function draw() {
    box.querySelector("svg")?.remove();
    const W = Math.max(280, box.clientWidth);
    const H = height;
    let ys = [];
    for (const s of opts.series) for (const [, v] of s.points) if (Number.isFinite(v)) ys.push(v);
    if (opts.markers) for (const [, v] of opts.markers.points) if (Number.isFinite(v)) ys.push(v);
    if (opts.ref) ys.push(opts.ref.y);
    if (opts.includeZero) ys.push(0);
    if (!ys.length || !base.length) { box.insertAdjacentHTML("afterbegin", `<div class="empty">표시할 데이터가 없어요</div>`); return; }
    const { lo, hi, ticks } = niceTicks(Math.min(...ys), Math.max(...ys), H < 220 ? 3 : 5);
    const labelW = Math.max(...ticks.map((v) => yFmt(v).length)) * 6.6 + 10;
    const m = { l: labelW, r: 12, t: 8, b: 24 };
    const x0 = t(base[0][0]), x1 = t(base[base.length - 1][0]) || x0 + 1;
    const X = (ms) => m.l + ((ms - x0) / Math.max(1, x1 - x0)) * (W - m.l - m.r);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo || 1)) * (H - m.t - m.b);

    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opts.series.map((s) => s.name).join(", ") });
    const gAxis = el("g", { class: "axis" }, svg);
    for (const v of ticks) {
      el("line", { class: "gridline", x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }, gAxis);
      const tx = el("text", { x: m.l - 8, y: Y(v) + 4, "text-anchor": "end" }, gAxis);
      tx.textContent = yFmt(v);
    }
    const dt = dateTicks(x0, x1, Math.max(2, Math.floor((W - m.l) / 80)));
    for (const ms of dt.ticks) {
      const tx = el("text", { x: X(ms), y: H - 6, "text-anchor": "middle" }, gAxis);
      tx.textContent = dt.fmt(ms);
    }
    if (opts.ref) {
      el("line", { class: "ref", x1: m.l, x2: W - m.r, y1: Y(opts.ref.y), y2: Y(opts.ref.y) }, svg);
      const rl = el("text", { class: "ref-label", x: W - m.r - 4, y: Y(opts.ref.y) - 5, "text-anchor": "end" }, svg);
      rl.textContent = opts.ref.label;
    }
    if (lo < 0 && hi > 0) el("line", { class: "baseline", x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0) }, svg);

    for (const s of opts.series) {
      const pts = s.points.filter(([, v]) => Number.isFinite(v));
      if (!pts.length) continue;
      let d = "";
      pts.forEach(([dd, v], i) => {
        const x = X(t(dd)), y = Y(v);
        if (i === 0) d += `M${x},${y}`;
        else if (s.step) d += `H${x}V${y}`;
        else d += `L${x},${y}`;
      });
      if (s.fill) {
        const yb = Y(Math.max(lo, Math.min(hi, 0)));
        el("path", { d: `${d}V${yb}H${X(t(pts[0][0]))}Z`, style: `fill:${s.fill};stroke:none` }, svg);
      }
      el("path", { d, style: `fill:none;stroke:${s.color};stroke-width:${s.width || 2};stroke-linejoin:round;stroke-linecap:round;${s.dash ? "stroke-dasharray:5 4;" : ""}` }, svg);
    }
    if (opts.markers) {
      for (const [dd, v] of opts.markers.points) {
        if (!Number.isFinite(v)) continue;
        const ms = t(dd); if (ms < x0 || ms > x1) continue;
        el("rect", { x: X(ms) - 4.5, y: Y(v) - 4.5, width: 9, height: 9, transform: `rotate(45 ${X(ms)} ${Y(v)})`, style: `fill:${opts.markers.color};stroke:var(--surface);stroke-width:2` }, svg);
      }
    }

    // 십자선 + 툴팁
    const cross = el("line", { class: "crosshair", y1: m.t, y2: H - m.b, visibility: "hidden" }, svg);
    const dots = opts.series.map((s) => el("circle", { r: 4, visibility: "hidden", style: `fill:${s.color};stroke:var(--surface);stroke-width:2` }, svg));
    const hit = el("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" }, svg);
    const xs = base.map(([d]) => t(d));
    const markerMap = opts.markers ? new Map(opts.markers.points) : null;
    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = ((ev.clientX - rect.left) / rect.width) * W;
      const ms = x0 + ((px - m.l) / (W - m.l - m.r)) * (x1 - x0);
      let lo2 = 0, hi2 = xs.length - 1;
      while (hi2 - lo2 > 1) { const mid = (lo2 + hi2) >> 1; if (xs[mid] < ms) lo2 = mid; else hi2 = mid; }
      const i = Math.abs(xs[lo2] - ms) <= Math.abs(xs[hi2] - ms) ? lo2 : hi2;
      const date = base[i][0];
      const cx = X(xs[i]);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      let rows = "";
      opts.series.forEach((s, k) => {
        const v = lookups[k].get(date);
        if (Number.isFinite(v)) { dots[k].setAttribute("cx", cx); dots[k].setAttribute("cy", Y(v)); dots[k].setAttribute("visibility", "visible"); }
        else dots[k].setAttribute("visibility", "hidden");
        rows += `<div class="t-row"><span class="k"><i style="background:${s.color}"></i>${s.name}</span><b>${Number.isFinite(v) ? tipFmt(v) : "-"}</b></div>`;
      });
      if (markerMap?.has(date)) rows += `<div class="t-row"><span class="k">${opts.markers.name}</span><b>${tipFmt(markerMap.get(date))}</b></div>`;
      tip.innerHTML = `<div class="t-date">${date}</div>${rows}`;
      tip.hidden = false;
      const bw = box.clientWidth, tw = tip.offsetWidth;
      const left = (cx / W) * bw;
      tip.style.left = `${left + 14 + tw > bw ? Math.max(0, left - 14 - tw) : left + 14}px`;
      tip.style.top = `${8}px`;
    };
    const leave = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", leave);
    box.appendChild(svg);
  }

  draw();
  let last = box.clientWidth;
  const ro = new ResizeObserver(() => { if (Math.abs(box.clientWidth - last) > 4) { last = box.clientWidth; draw(); } });
  ro.observe(box);
}

/** 가로 막대 (비중). rows: [{name, frac, label, sub?}] */
export function barList(container, rows) {
  const max = Math.max(...rows.map((r) => r.frac), 0) || 1;
  container.innerHTML = `<div class="bars">${rows.map((r) => `
    <div class="bar-row" title="${r.name}: ${r.label}${r.sub ? " · " + r.sub : ""}">
      <span class="name">${r.name}</span>
      <span class="bar-track"><span class="bar-fill" style="display:block;width:${(r.frac / max) * 100}%"></span></span>
      <span class="val">${r.label}${r.sub ? `<small>${r.sub}</small>` : ""}</span>
    </div>`).join("")}</div>`;
}

/**
 * 도넛 (카테고리 비중). items: [{name, frac(0~1), won?}]
 * 색은 8색 고정 순서(--cat-1..8). 8개를 넘으면 작은 것부터 "기타"로 묶는다 (9번째 색은 만들지 않음).
 * opts: {center, centerSub, fmtWon}
 */
export function donut(container, items, opts = {}) {
  let rows = items.filter((r) => r.frac > 0).sort((a, b) => b.frac - a.frac);
  if (rows.length > 8) {
    const head = rows.slice(0, 7), tail = rows.slice(7);
    const won = tail.every((r) => Number.isFinite(r.won)) ? tail.reduce((s, r) => s + r.won, 0) : null;
    rows = [...head, { name: `기타 (${tail.length})`, frac: tail.reduce((s, r) => s + r.frac, 0), won, members: tail.map((r) => r.name) }];
  }
  rows.forEach((r, i) => { r.color = `var(--cat-${i + 1})`; });
  const escX = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const size = opts.size || 220, cx = size / 2, cy = size / 2;
  const R = size * 0.46, r0 = opts.inside ? R * 0.5 : R * 0.62; // 안쪽 글씨 모드는 고리를 두껍게
  const labeled = new Set();
  const total = rows.reduce((s, r) => s + r.frac, 0) || 1;
  const gap = rows.length > 1 ? 0.012 : 0; // 조각 사이 틈 (라디안 비율)
  let a0 = -Math.PI / 2;
  const pt = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const paths = rows.map((r, i) => {
    const sweep = (r.frac / total) * Math.PI * 2;
    const s = a0 + gap, e = a0 + sweep - gap;
    a0 += sweep;
    if (rows.length === 1) return `<circle cx="${cx}" cy="${cy}" r="${(R + r0) / 2}" style="fill:none;stroke:${r.color};stroke-width:${R - r0}" data-i="${i}"/>`;
    if (e <= s) return "";
    const large = e - s > Math.PI ? 1 : 0;
    const [x1, y1] = pt(R, s), [x2, y2] = pt(R, e), [x3, y3] = pt(r0, e), [x4, y4] = pt(r0, s);
    const mid = (s + e) / 2;
    const [lx, ly] = pt((R + r0) / 2, mid);
    const ink = [2, 3, 4].includes(i) ? "#111" : "#fff"; // 밝은 조각엔 어두운 글씨
    const share = r.frac / total;
    let label = "";
    if (opts.inside && share >= 0.04) {
      // Streamlit 처럼 조각 안에 이름 + % (좁은 조각은 이름을 줄임)
      const maxCh = share >= 0.12 ? 10 : share >= 0.05 ? 8 : 5;
      const nm = r.name.length > maxCh ? r.name.slice(0, maxCh - 1) + "…" : r.name;
      label = `<text x="${lx}" y="${ly - 2}" text-anchor="middle" class="d-name" style="fill:${ink}">${escX(nm)}</text><text x="${lx}" y="${ly + 13}" text-anchor="middle" class="d-pct" style="fill:${ink}">${(share * 100).toFixed(1)}%</text>`;
      labeled.add(i);
    } else if (!opts.inside && share >= 0.07) {
      label = `<text x="${lx}" y="${ly + 4}" text-anchor="middle" class="d-pct" style="fill:${ink}">${Math.round(share * 100)}%</text>`;
    }
    return `<path d="M${x1},${y1}A${R},${R} 0 ${large} 1 ${x2},${y2}L${x3},${y3}A${r0},${r0} 0 ${large} 0 ${x4},${y4}Z" style="fill:${r.color}" data-i="${i}"/>${label}`;
  }).join("");
  const pct = (f) => `${((f / total) * 100).toFixed(1)}%`;
  container.innerHTML = `
    <div class="donut-wrap">
      <div class="donut" role="img" aria-label="카테고리 비중 ${rows.map((r) => `${r.name} ${pct(r.frac)}`).join(", ")}">
        <svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${paths}
          <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="d-center" style="font-size:${Math.round(size / 12)}px">${escX(opts.center ?? "")}</text>
          <text x="${cx}" y="${cy + size / 16}" text-anchor="middle" class="d-sub">${escX(opts.centerSub ?? "")}</text>
        </svg>
        <div class="tooltip" hidden></div>
      </div>
      <ul class="d-legend${opts.inside ? " compact" : ""}">${rows.map((r, i) => opts.inside && labeled.has(i) ? "" : `
        <li data-i="${i}" title="${r.members ? r.members.join(", ") : r.name}"><span class="sw" style="background:${r.color}"></span><span class="nm">${escX(r.name)}</span>
          <b>${pct(r.frac)}</b>${Number.isFinite(r.won) && opts.fmtWon ? `<small>${opts.fmtWon(r.won)}</small>` : ""}</li>`).join("")}
      </ul>
    </div>`;
  // 마우스를 올리면 그 조각만 진하게 + 툴팁 (범례에 올려도 같은 동작)
  const svg = container.querySelector("svg");
  const tip = container.querySelector(".tooltip");
  const segs = [...container.querySelectorAll("svg [data-i]")];
  const lis = [...container.querySelectorAll(".d-legend li")];
  const show = (i, ev) => {
    segs.forEach((s) => s.classList.toggle("dim", +s.dataset.i !== i));
    lis.forEach((l) => l.classList.toggle("on", +l.dataset.i === i));
    const r = rows[i];
    tip.innerHTML = `<div class="t-row"><span class="k"><i style="background:${r.color};height:10px"></i>${r.name}</span><b>${pct(r.frac)}</b></div>${Number.isFinite(r.won) && opts.fmtWon ? `<div class="t-row"><span class="k">평가액</span><b>${opts.fmtWon(r.won)}</b></div>` : ""}${r.members ? `<div class="t-date" style="margin:4px 0 0">${r.members.join(", ")}</div>` : ""}`;
    tip.hidden = false;
    if (ev) {
      const box = container.querySelector(".donut").getBoundingClientRect();
      tip.style.left = `${Math.min(ev.clientX - box.left + 12, box.width - tip.offsetWidth)}px`;
      tip.style.top = `${ev.clientY - box.top + 12}px`;
    } else { tip.style.left = "8px"; tip.style.top = "8px"; }
  };
  const hide = () => { segs.forEach((s) => s.classList.remove("dim")); lis.forEach((l) => l.classList.remove("on")); tip.hidden = true; };
  segs.forEach((s) => { s.addEventListener("pointermove", (ev) => show(+s.dataset.i, ev)); s.addEventListener("pointerleave", hide); });
  lis.forEach((l) => { l.addEventListener("pointerenter", () => show(+l.dataset.i)); l.addEventListener("pointerleave", hide); });
  svg.addEventListener("pointerleave", hide);
}
