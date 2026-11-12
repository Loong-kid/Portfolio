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
