// 편집 API 종단 시험 — 반드시 "시험용 사본" 시트에만 돌릴 것.
// 사용: node web/test/edit_e2e.mjs <BASE_URL> <cookie "pf_session=..."> <SA키.json> <시험용 시트ID>
// 각 저장 뒤 시트를 직접 읽어 (1) 의도한 변경이 들어갔는지 (2) 나머지는 그대로인지 확인한다.
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const G = await import(pathToFileURL(join(here, "../src/google.js")).href);
const C = await import(pathToFileURL(join(here, "../src/calc.js")).href);

const [BASE, COOKIE, SA, SHEET] = process.argv.slice(2);
const env = { GCP_SA_JSON: readFileSync(SA, "utf8") };
const TABS = Object.keys(C.SCHEMAS);
const read = () => G.readTabs(env, SHEET, TABS);
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { cookie: COOKIE, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error}`);
  return j;
}
let fails = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? "✅" : "❌"} ${msg}`); if (!cond) fails++; };
const num = (v) => C.toNum(v);
const sameNum = (a, b) => (Number.isNaN(num(a)) && Number.isNaN(num(b))) || Math.abs(num(a) - num(b)) < 1e-6 * Math.max(1, Math.abs(num(a)));
/** 행 목록을 값 기준으로 비교 (숫자는 숫자로) */
function sameRows(a, b, cols) {
  if (a.length !== b.length) return false;
  return a.every((r, i) => cols.every((c) => { const x = r[c] ?? "", y = b[i][c] ?? ""; return x === y || (x !== "" && y !== "" && sameNum(x, y)); }));
}
const today = C.todayKst();

const orig = await read();
console.log(`시험용 시트: 스냅샷 ${orig.snapshots.length}행, flows ${orig.flows.length}, debt ${orig.debt_history.length}, notes ${orig.stock_notes.length}, watchlist ${orig.watchlist.length}`);

// 1) 스냅샷: 오늘 새로 만들기 (carry-over + 시세) → 저장
console.log("1) 스냅샷 새로 저장");
const g = await call("GET", `/api/snapshots?date=${today}&mode=new`);
ok(g.rows.length > 0 && g.isToday, `오늘 스냅샷 초안 ${g.rows.length}행 (이전: ${g.carryFrom || "같은 날 있음"})`);
ok(g.rows.every((r) => r.평가액 != null), "초안의 평가액이 모두 채워짐");
const s1 = await call("PUT", "/api/snapshots", { date: today, rows: g.rows });
let t = await read();
const bySnap = (a, b) => (C.toDate(a["날짜"]) + a["종목"] < C.toDate(b["날짜"]) + b["종목"] ? -1 : 1);
const others = (tabs) => tabs.snapshots.filter((r) => C.toDate(r["날짜"]) !== today).sort(bySnap);
ok(sameRows(others(t), others(orig), C.SCHEMAS.snapshots), "다른 날짜 스냅샷은 그대로");
const mine = t.snapshots.filter((r) => C.toDate(r["날짜"]) === today);
ok(mine.length === s1.rows, `오늘 행 ${mine.length}개 저장`);
ok(Math.abs(mine.reduce((s, r) => s + num(r["평가액"]), 0) - s1.total) < 1, `평가액 합계 일치 ${Math.round(s1.total).toLocaleString()}`);

// 2) 수량 0 행 제거 + 중복 종목 마지막 행 유지
console.log("2) 저장 규칙 (수량 0 제거 · 중복은 마지막)");
const rows2 = g.rows.map((r) => ({ ...r }));
rows2.push({ ...rows2[0], 수량: 0 });                 // 0 → 빠져야 함 (같은 종목이지만 0이라 먼저 걸러짐)
rows2.push({ 종목: "시험종목", 통화: "KRW", 수량: 1, 평균단가: 100, 현재가: 200, 환율: 1, 평가액: null }); // 평가액 자동 계산
rows2.push({ 종목: "시험종목", 통화: "KRW", 수량: 2, 평균단가: 100, 현재가: 300, 환율: 1, 평가액: null }); // 중복 → 이 행이 남아야
await call("PUT", "/api/snapshots", { date: today, rows: rows2 });
t = await read();
const tr = t.snapshots.filter((r) => C.toDate(r["날짜"]) === today && r["종목"] === "시험종목");
ok(tr.length === 1 && num(tr[0]["수량"]) === 2 && num(tr[0]["평가액"]) === 600, "중복 종목은 마지막 행, 평가액 = 2×300×1 = 600");
ok(t.snapshots.filter((r) => C.toDate(r["날짜"]) === today).length === g.rows.length + 1, "수량 0 행은 빠짐");

// 3) 지금 시세로 갱신 + 저장
console.log("3) 지금 시세로 갱신 + 저장");
const s3 = await call("POST", "/api/snapshots/refresh", { date: today, rows: g.rows });
ok(s3.rows === g.rows.length, `${s3.rows}행 저장, 못 받은 종목: ${s3.missing.join(", ") || "없음"}`);
t = await read();
ok(sameRows(others(t), others(orig), C.SCHEMAS.snapshots), "다른 날짜 스냅샷은 그대로");

// 4) 스냅샷 삭제 → 원래대로
console.log("4) 오늘 스냅샷 삭제");
const hadToday = orig.snapshots.some((r) => C.toDate(r["날짜"]) === today);
if (!hadToday) {
  await call("DELETE", `/api/snapshots?date=${today}`);
  t = await read();
  ok(sameRows([...t.snapshots].sort(bySnap), [...orig.snapshots].sort(bySnap), C.SCHEMAS.snapshots), "스냅샷 탭이 시험 전과 같음 (정렬 기준)");
} else console.log("  (원본에 오늘 스냅샷이 있어 삭제 시험은 건너뜀)");

// 5) 자금 흐름: 추가 → 목록 저장으로 되돌리기
console.log("5) 자금 흐름");
const f0 = await call("GET", "/api/flows");
await call("POST", "/api/flows", { 날짜: "2026-11-14", 통화: "USD", 금액: -123.45, 메모: "시험 (토요일)" });
t = await read();
ok(t.flows.length === orig.flows.length + 1 && t.flows.at(-1)["메모"] === "시험 (토요일)" && num(t.flows.at(-1)["금액"]) === -123.45, "한 행 추가됨 (음수·USD)");
await call("PUT", "/api/flows", { rows: f0.flows });
t = await read();
const normCcy = (rows) => rows.map((r) => ({ ...r, 통화: r["통화"] || "KRW" })); // 빈 통화 → KRW (파이썬 save_flows 와 같음)
ok(sameRows(t.flows, normCcy(orig.flows), C.SCHEMAS.flows), "목록 저장으로 원래대로 (빈 통화는 KRW 로)");

// 6) 부채: 추가 → 삭제
console.log("6) 부채");
await call("POST", "/api/debt", { 날짜: "2026-11-13", 부채: 12345678, 메모: "시험" });
t = await read();
ok(t.debt_history.some((r) => C.toDate(r["날짜"]) === "2026-11-13" && num(r["부채"]) === 12345678), "부채 기록 추가");
await call("DELETE", "/api/debt?date=2026-11-13");
t = await read();
ok(sameRows(t.debt_history, orig.debt_history, C.SCHEMAS.debt_history), "삭제 후 원래대로");

// 7) 종목 메모: 그대로 저장 → 보유 외 종목 메모 보존 확인
console.log("7) 종목 메모");
const P = await call("GET", "/api/portfolio");
const notesIn = P.notes.map((n) => ({ ...n }));
if (notesIn.length) notesIn[0] = { ...notesIn[0], 업사이드_메모: (notesIn[0].업사이드_메모 || "") + " [시험]", 목표가_상단: 99999 };
await call("PUT", "/api/notes", { rows: notesIn });
t = await read();
const n0 = t.stock_notes.find((r) => r["종목"] === notesIn[0]?.종목);
ok(!notesIn.length || (n0 && n0["업사이드_메모"].endsWith("[시험]") && num(n0["목표가_상단"]) === 99999), "편집한 메모·목표가 저장");
const heldNames = new Set(P.notes.map((n) => n.종목));
const othersBefore = orig.stock_notes.filter((r) => !heldNames.has(r["종목"]));
const othersAfter = t.stock_notes.filter((r) => !heldNames.has(r["종목"]));
ok(sameRows(othersAfter, othersBefore, C.SCHEMAS.stock_notes), `보유 외 종목 메모 ${othersBefore.length}개 보존`);
// 원래대로 (시트 원본 그대로 다시 쓰기)
await G.writeTab(env, SHEET, "stock_notes", C.SCHEMAS.stock_notes, orig.stock_notes);

// 8) 관찰 종목: 등록 → 삭제
console.log("8) 관찰 종목");
const w = await call("POST", "/api/watchlist", { 종목: "시험관찰", 심볼: "NVDA", 통화: "USD" });
t = await read();
ok(w.status === "added" && t.watchlist.some((r) => r["종목"] === "시험관찰") && t.ticker_map.some((r) => r["종목"] === "시험관찰" && r["yfinance_symbol"] === "NVDA"), "관찰 종목 + 심볼 등록");
let bad = null; try { await call("POST", "/api/watchlist", { 종목: P.notes[0]?.종목 || "x", 심볼: "X", 통화: "KRW" }); } catch (e) { bad = e.message; }
ok(!P.notes.length || /이미 보유/.test(bad || ""), "보유 종목은 관찰 등록 거부");
await call("PUT", "/api/watchlist", { rows: orig.watchlist.map((r) => ({ ...r })) });
await call("PUT", "/api/tickers", { rows: orig.ticker_map.map((r) => ({ 종목: r["종목"], 심볼: r["yfinance_symbol"] })) });

// 9) 순서 / 카테고리 / 심볼 — 그대로 저장해도 내용이 같아야
console.log("9) 순서·카테고리·심볼 왕복");
const order = Object.fromEntries(orig.portfolio_order.map((r) => [r["종목"], r["순서"]]));
await call("PUT", "/api/order", { order });
const st = await call("GET", "/api/settings");
await call("PUT", "/api/categories", { rows: st.categories });
await call("PUT", "/api/tickers", { rows: st.tickers });
t = await read();
const asMap = (rows, k, v) => JSON.stringify(Object.fromEntries(rows.map((r) => [r[k], String(r[v])])));
ok(asMap(t.portfolio_order, "종목", "순서") === asMap(orig.portfolio_order, "종목", "순서"), "순서 같음");
ok(asMap(t.categories, "종목", "카테고리") === asMap(orig.categories, "종목", "카테고리"), "카테고리 같음");
ok(asMap(t.ticker_map, "종목", "yfinance_symbol") === asMap(orig.ticker_map, "종목", "yfinance_symbol"), "심볼 같음");

// 마지막: 전체가 시험 전과 같은지
console.log("최종 확인");
t = await read();
for (const tab of TABS) {
  const same = ["portfolio_order", "categories", "ticker_map"].includes(tab)
    ? JSON.stringify(t[tab].map((r) => Object.values(r)).sort()) === JSON.stringify(orig[tab].map((r) => Object.values(r)).sort())
    : tab === "flows" ? sameRows(t.flows, orig.flows.map((r) => ({ ...r, 통화: r["통화"] || "KRW" })), C.SCHEMAS.flows)
    : tab === "snapshots" ? sameRows([...t[tab]].sort(bySnap), [...orig[tab]].sort(bySnap), C.SCHEMAS[tab]) : sameRows(t[tab], orig[tab], C.SCHEMAS[tab]);
  ok(same, `${tab} 시험 전과 같음`);
}
console.log(fails ? `\n❌ 실패 ${fails}건` : "\n✅ 편집 시험 전부 통과");
process.exit(fails ? 1 : 0);
