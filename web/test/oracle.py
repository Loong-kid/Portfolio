"""파이썬(Streamlit) 계산을 정답지로 덤프한다.

사용: (portfolio-monitor-cloud 폴더에서)
  set GOOGLE_SA_JSON=<키 파일 경로>  /  GOOGLE_SHEET_ID=<시트 ID>
  .venv/Scripts/python.exe web/test/oracle.py <out.json> [--prices <prices.json>]

--prices 없으면 data_fetcher(yfinance/pykrx)로 가격·환율 이력을 받아 출력에 같이 넣는다.
JS 쪽(compare.mjs)은 이 출력의 inputs.prices 를 그대로 받아 같은 입력으로 계산한다.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")

import pandas as pd  # noqa: E402
import portfolio as P  # noqa: E402
from config import now_kst, load_category_map  # noqa: E402


def series_to_list(s: pd.Series) -> list:
    s = s.dropna()
    return [[pd.Timestamp(i).strftime("%Y-%m-%d"), float(v)] for i, v in s.items()]


def list_to_series(lst: list) -> pd.Series:
    if not lst:
        return pd.Series(dtype=float)
    return pd.Series([v for _, v in lst], index=pd.to_datetime([d for d, _ in lst]))


def main():
    out_path = sys.argv[1]
    prices_in = None
    if "--prices" in sys.argv:
        prices_in = json.loads(Path(sys.argv[sys.argv.index("--prices") + 1]).read_text("utf-8"))

    today = pd.Timestamp(now_kst()).normalize()
    snaps = P.load_snapshots()
    flows = P.load_flows()
    debt = P.load_debt_history()
    anchors = P.load_nav_anchors()
    holdings = P.get_latest_snapshot()

    starts = []
    if not snaps.empty:
        starts.append(snaps["날짜"].min().normalize())
    if not anchors.empty:
        starts.append(anchors["날짜"].min().normalize())
    d_first = min(starts)

    stock_tickers = sorted(t for t in snaps["종목"].unique()
                           if t not in P.CASH_TICKERS and t not in P.ACCOUNT_TICKERS and "→" not in str(t))

    if prices_in is None:
        from data_fetcher import get_price_history, get_fx_history, get_prices_bulk, get_current_fx
        ph = {t: series_to_list(get_price_history(t, d_first.to_pydatetime(), today.to_pydatetime()))
              for t in stock_tickers}
        fh = {c: series_to_list(get_fx_history(c, d_first.to_pydatetime(), today.to_pydatetime()))
              for c in ("USD", "EUR", "JPY")}
        tradable = [t for t in holdings.index if t not in P.CASH_TICKERS and t not in P.ACCOUNT_TICKERS]
        cur = get_prices_bulk(tradable)
        fx_now = get_current_fx()
        prices_in = {"price_hist": ph, "fx_hist": fh, "current": cur, "fx": fx_now}

    price_hist = {t: list_to_series(v) for t, v in prices_in["price_hist"].items()}
    fx_hist = {c: list_to_series(v) for c, v in prices_in["fx_hist"].items()}

    nav = P.compute_nav_history(snaps, flows, debt, price_hist, fx_hist,
                                nav_anchors_df=anchors, start=d_first, end=today,
                                business_days_only=True)
    inc = P.compute_income_summary(nav, flows, today=today)

    snap_prices = {t: float(v) for t, v in holdings["현재가"].items() if pd.notna(v) and float(v) > 0}
    valued = P.value_holdings(holdings, prices_in["current"], prices_in["fx"], snapshot_prices=snap_prices)
    cat = P.category_breakdown(valued)

    nav_out = nav.copy()
    nav_out["날짜"] = pd.to_datetime(nav_out["날짜"]).dt.strftime("%Y-%m-%d")
    valued_out = valued.reset_index()[["종목", "카테고리", "통화", "환율", "수량", "평균단가",
                                        "현재가", "평가액", "원가", "평가손익", "수익률", "가격출처"]]
    result = {
        "today": today.strftime("%Y-%m-%d"),
        "start": d_first.strftime("%Y-%m-%d"),
        "inputs": {"prices": prices_in},
        "nav": json.loads(nav_out.to_json(orient="records", force_ascii=False)),
        "income": inc,
        "valued": json.loads(valued_out.to_json(orient="records", force_ascii=False)),
        "category": json.loads(cat.to_json(orient="records", force_ascii=False)),
        "categories_map": load_category_map(),
    }
    Path(out_path).write_text(json.dumps(result, ensure_ascii=False, indent=1), "utf-8")
    print(f"nav rows {len(nav)} · valued {len(valued)} · income {inc.get('cum_income')}")


if __name__ == "__main__":
    main()
