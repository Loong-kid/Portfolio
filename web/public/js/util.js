// 화면 공통: 이스케이프·숫자 서식·API 호출·로컬 저장
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const isNum = (v) => typeof v === "number" && Number.isFinite(v);
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 사생활 보호 모드 */ } },
};

export const fmt = {
  krw(v) {
    if (!isNum(v)) return "-";
    const a = Math.abs(v), s = v < 0 ? "-" : "";
    if (a >= 1e8) return `${s}₩${(a / 1e8).toFixed(2)}억`;
    if (a >= 1e4) return `${s}₩${Math.round(a / 1e4).toLocaleString("ko-KR")}만`;
    return `${s}₩${Math.round(a).toLocaleString("ko-KR")}`;
  },
  won(v) { return isNum(v) ? `${v < 0 ? "-" : ""}₩${Math.round(Math.abs(v)).toLocaleString("ko-KR")}` : "-"; },
  pct(v, d = 2) { return isNum(v) ? `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%` : "-"; },
  pctRaw(v, d = 1) { return isNum(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(d)}%` : "-"; },
  price(v, ccy) {
    if (!isNum(v)) return "-";
    if (ccy === "KRW" || Math.abs(v) >= 10000) return Math.round(v).toLocaleString("ko-KR");
    return v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },
  qty(v) { return isNum(v) ? v.toLocaleString("ko-KR", { maximumFractionDigits: 4 }) : "-"; },
  num(v, d = 2) { return isNum(v) ? v.toLocaleString("ko-KR", { minimumFractionDigits: d, maximumFractionDigits: d }) : "-"; },
  axisKrw(v) {
    const a = Math.abs(v);
    if (a >= 1e8) return `${+(v / 1e8).toFixed(1)}억`;
    if (a >= 1e4) return `${Math.round(v / 1e4).toLocaleString("ko-KR")}만`;
    return Math.round(v).toLocaleString("ko-KR");
  },
  time(ms) { return ms ? new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" }) : "-"; },
};
export const signCls = (v) => (isNum(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "");

export async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...opts });
  const j = await r.json().catch(() => ({ error: `응답 오류 (${r.status})` }));
  if (!r.ok) { const e = new Error(j.error || `오류 ${r.status}`); e.status = r.status; throw e; }
  return j;
}
