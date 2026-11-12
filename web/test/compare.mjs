// 파이썬 정답지(oracle.py 출력)와 JS 이식본(src/calc.js)을 같은 입력으로 대조한다.
// 사용: node web/test/compare.mjs <oracle.json> <SA키.json> <시트ID>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const C = await import(pathToFileURL(join(here, "../src/calc.js")).href);
const G = await import(pathToFileURL(join(here, "../src/google.js")).href);

const [oraclePath, saPath, sheetId] = process.argv.slice(2);
const oracle = JSON.parse(readFileSync(oraclePath, "utf8"));
const env = { GCP_SA_JSON: readFileSync(saPath, "utf8") };

const tabs = await G.readTabs(env, sheetId, Object.keys(C.SCHEMAS));
const snaps = C.loadSnapshots(tabs.snapshots);
const flows = C.loadFlows(tabs.flows);
const debt = C.loadDebt(tabs.debt_history);
const anchors = C.loadAnchors(tabs.nav_anchors);
const catMap = C.loadMap(tabs.categories, "종목", "카테고리");
const today = oracle.today;
const P = oracle.inputs.prices;

const nav = C.computeNavHistory({
  snaps, flows, debt, anchors, priceHist: P.price_hist, fxHist: P.fx_hist,
  start: oracle.start, end: today, today,
});
const inc = C.computeIncomeSummary(nav, flows, today);
const latest = C.snapshotAtOrBefore(snaps, today);
const valued = C.valueHoldings(latest.rows, P.current, P.fx, catMap);
const cat = C.categoryBreakdown(valued);

let fails = 0, checks = 0;
const close = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return (a == null && Number.isNaN(b)) || (b == null && Number.isNaN(a));
  if (typeof a === "string" || typeof b === "string") return a === b;
  return Math.abs(a - b) <= Math.max(1e-6, 1e-9 * Math.max(Math.abs(a), Math.abs(b)));
};
function cmp(label, py, js) {
  checks++;
  if (!close(py, js)) { fails++; if (fails <= 25) console.log(`  ✗ ${label}: python=${py} js=${js}`); }
}

console.log(`nav rows: python ${oracle.nav.length} / js ${nav.length}`);
cmp("nav length", oracle.nav.length, nav.length);
const cols = ["총자산", "순자산", "부채", "외부유입_총", "외부유입_순", "좌수_총", "좌수_순", "기준가_총자산", "기준가_순자산"];
oracle.nav.forEach((r, i) => {
  const j = nav[i] || {};
  cmp(`nav[${r.날짜}].날짜`, r.날짜, j.날짜);
  for (const c of cols) cmp(`nav[${r.날짜}].${c}`, r[c], j[c]);
});
for (const k of Object.keys(oracle.income)) cmp(`income.${k}`, oracle.income[k], inc[k]);

console.log(`valued rows: python ${oracle.valued.length} / js ${valued.length}`);
const vj = new Map(valued.map((v) => [v.종목, v]));
for (const r of oracle.valued) {
  const j = vj.get(r.종목);
  if (!j) { cmp(`valued ${r.종목} 존재`, "있음", "없음"); continue; }
  for (const c of ["카테고리", "통화", "환율", "수량", "평균단가", "현재가", "평가액", "원가", "평가손익", "수익률", "가격출처"])
    cmp(`valued[${r.종목}].${c}`, r[c], j[c]);
}
const cj = new Map(cat.map((c) => [c.카테고리, c]));
for (const r of oracle.category) { cmp(`category[${r.카테고리}].평가액`, r.평가액, cj.get(r.카테고리)?.평가액); cmp(`category[${r.카테고리}].비중`, r.비중, cj.get(r.카테고리)?.비중); }

console.log(`\n${fails === 0 ? "✅ 전부 일치" : `❌ 불일치 ${fails}건`} (비교 ${checks}개)`);
console.log(`누적 금융수익금 python ${oracle.income.cum_income?.toFixed(0)} / js ${inc.cum_income?.toFixed(0)}`);
process.exit(fails ? 1 : 0);
