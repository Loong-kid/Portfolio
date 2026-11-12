// 재무 수집 점검: node test/fin_check.mjs 183300.KQ SCCO AIXA.DE
import { fetchFundamentals } from "../src/fundamentals.js";
import { Budget } from "../src/prices.js";
for (const sym of process.argv.slice(2)) {
  const b = new Budget(10);
  const f = await fetchFundamentals(sym, null, b);
  const u = f.ccy === "KRW" ? 1e8 : 1e6;
  const r = (x) => (typeof x === "number" ? Math.round(x / u).toLocaleString() : "-");
  console.log(`== ${sym} ccy=${f.ccy} calls=${10 - b.left} warn=${f.warn}`);
  console.log(" A", f.annual.map((a) => `${a.k}[${a.src}] rev ${r(a.rev)} oi ${r(a.oi)} ni ${r(a.ni)} fcf ${r(a.fcf)}`).join("\n   "));
  console.log(" Q", f.quarterly.map((a) => `${a.k}${a.d ? "*" : ""}[${a.src}] rev ${r(a.rev)} oi ${r(a.oi)} ni ${r(a.ni)}`).join("\n   "));
  console.log(" E", JSON.stringify(f.cons.annual.map((c) => [c.k, r(c.rev), r(c.oi), c.eps, c.per])), JSON.stringify(f.cons.quarterly.map((c) => [c.k, r(c.rev), r(c.oi)])));
  console.log(" BS", JSON.stringify(f.bs));
}
