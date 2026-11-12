// 새 시세 모듈 vs 파이썬 정답지의 현재가/이력 비교 (출처가 달라 완전 일치는 기대하지 않음)
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const X = await import(pathToFileURL(join(here, "../src/prices.js")).href);
const C = await import(pathToFileURL(join(here, "../src/calc.js")).href);
const G = await import(pathToFileURL(join(here, "../src/google.js")).href);
const [oraclePath, saPath, sheetId] = process.argv.slice(2);
const o = JSON.parse(readFileSync(oraclePath, "utf8"));
const tabs = await G.readTabs({ GCP_SA_JSON: readFileSync(saPath, "utf8") }, sheetId, ["ticker_map"]);
const tmap = C.loadMap(tabs.ticker_map, "종목", "yfinance_symbol");
const budget = new X.Budget(200);
const names = Object.keys(o.inputs.prices.current);
const syms = names.map((n) => tmap[n]);
const codes = {};
for (const s of syms) if (X.classify(s).kind === "world") codes[s] = await X.resolveNaverCode(s, budget);
const t0 = Date.now();
const cur = await X.fetchCurrent(syms, codes, new X.Budget(50));
const fx = await X.fetchFx(new X.Budget(10));
console.log(`현재가 ${Object.keys(cur).length}/${syms.length}개, ${Date.now() - t0}ms`);
for (const n of names) {
  const s = tmap[n], c = cur[s], py = o.inputs.prices.current[n];
  const diff = c ? ((c.p / py - 1) * 100).toFixed(2) + "%" : "-";
  console.log(`  ${n.padEnd(12)} ${s.padEnd(10)} new=${c ? c.p + " (" + c.src + " " + c.d + ")" : "실패"}  py=${py}  차이 ${diff}`);
}
for (const k of ["USD", "EUR", "JPY"]) console.log(`  FX ${k}: new=${fx[k]?.p} (${fx[k]?.src})  py=${o.inputs.prices.fx[k]}`);
// 이력 3개만 표본
for (const n of names.slice(0, 2).concat(names.filter((n) => tmap[n].endsWith(".DE")))) {
  const h = await X.fetchHistory(tmap[n], "2026-10-01", o.today, new X.Budget(5));
  const pyh = new Map(o.inputs.prices.price_hist[n]);
  const diffs = h.filter(([d]) => pyh.has(d)).map(([d, v]) => Math.abs(v / pyh.get(d) - 1));
  console.log(`  이력 ${n}: ${h.length}일, 파이썬과 같은 날 ${diffs.length}일, 최대차이 ${(Math.max(0, ...diffs) * 100).toFixed(3)}%`);
}
