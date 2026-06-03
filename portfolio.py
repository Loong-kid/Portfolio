"""Portfolio engine — snapshot-primary architecture.

The single source of truth is the `snapshots` tab (rows of date × ticker × qty × avg).
External cash flows (deposits/withdrawals) live in `flows`. Debt LOCF lives in
`debt_history`. Everything else (current portfolio, NAV history, 좌수/기준가,
금융수익금) is *derived* from these three tabs + market prices.

There is no transaction replay. Past data is fixed; the only way to change
current state is to write a new snapshot.
"""
from __future__ import annotations
import pandas as pd
import numpy as np
from datetime import datetime
from config import DEFAULT_FX, load_category_map
import sheets_db


CASH_TICKERS = {"KRW현금", "USD현금", "EUR현금", "JPY현금"}
ACCOUNT_TICKERS = {"개인연금", "퇴직연금"}

SNAPSHOT_HEADERS = ["날짜", "종목", "통화", "수량", "평균단가",
                     "현재가", "환율", "평가액"]
FLOW_HEADERS = ["날짜", "통화", "금액", "메모"]
DEBT_HEADERS = ["날짜", "부채", "메모"]
NAV_ANCHOR_HEADERS = ["날짜", "총자산", "순자산", "좌수_총", "좌수_순",
                       "기준가_총자산", "기준가_순자산"]
STOCK_NOTES_HEADERS = ["종목", "목표가_상단", "목표가_하단",
                        "업사이드_메모", "다운사이드_메모", "업데이트일"]


# ============== portfolio_order ==============

def load_portfolio_order() -> dict[str, int]:
    df = sheets_db.read_tab("portfolio_order")
    out: dict[str, int] = {}
    for _, row in df.iterrows():
        ticker = str(row.get("종목", "")).strip()
        try:
            rank = int(float(str(row.get("순서") or 0)))
        except (TypeError, ValueError):
            continue
        if ticker:
            out[ticker] = rank
    return out


def save_portfolio_order(order: dict[str, int]) -> None:
    rows = [{"종목": t, "순서": r}
            for t, r in sorted(order.items(), key=lambda kv: kv[1])]
    df = pd.DataFrame(rows, columns=["종목", "순서"])
    sheets_db.write_tab("portfolio_order", df)


# ============== stock_notes ==============

def load_stock_notes() -> pd.DataFrame:
    df = sheets_db.read_tab("stock_notes")
    for col in STOCK_NOTES_HEADERS:
        if col not in df.columns:
            df[col] = ""
    df["목표가_상단"] = pd.to_numeric(df["목표가_상단"], errors="coerce")
    df["목표가_하단"] = pd.to_numeric(df["목표가_하단"], errors="coerce")
    return df[STOCK_NOTES_HEADERS]


def save_stock_notes(df: pd.DataFrame) -> None:
    out = df.copy()
    for col in STOCK_NOTES_HEADERS:
        if col not in out.columns:
            out[col] = ""
    out = out[STOCK_NOTES_HEADERS]
    out["종목"] = out["종목"].astype(str).str.strip()
    out = out[out["종목"] != ""].reset_index(drop=True)
    sheets_db.write_tab("stock_notes", out)


# ============== snapshots ==============

def load_snapshots() -> pd.DataFrame:
    """All snapshot rows.

    Columns: 날짜, 종목, 통화, 수량, 평균단가, 현재가, 환율, 평가액.
    `현재가`/`환율`/`평가액`은 그 스냅샷 시점의 가격·환율·KRW 평가액 (사용자가
    저장 당시 시점값 기록). 비어있으면 chart가 yfinance로 derive 시도.
    """
    df = sheets_db.read_tab("snapshots")
    if df.empty:
        empty = pd.DataFrame(columns=SNAPSHOT_HEADERS)
        empty["날짜"] = pd.to_datetime(empty["날짜"])
        return empty
    df["날짜"] = pd.to_datetime(df["날짜"], errors="coerce")
    for col in ("수량", "평균단가", "현재가", "환율", "평가액"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        else:
            df[col] = float("nan")
    df = df.dropna(subset=["날짜", "종목"])
    df["종목"] = df["종목"].astype(str).str.strip()
    df["통화"] = df["통화"].astype(str).str.strip().replace("", "KRW")
    return df.sort_values("날짜").reset_index(drop=True)


def list_snapshot_dates() -> pd.DataFrame:
    """Per-date row count, descending."""
    df = load_snapshots()
    if df.empty:
        return pd.DataFrame(columns=["날짜", "행수"])
    g = df.groupby(df["날짜"].dt.normalize()).size().reset_index(name="행수")
    return g.sort_values("날짜", ascending=False).reset_index(drop=True)


def latest_snapshot_date() -> datetime | None:
    df = load_snapshots()
    if df.empty:
        return None
    return df["날짜"].max()


def get_snapshot(date_: datetime) -> pd.DataFrame:
    """Rows on exactly that date, indexed by 종목."""
    df = load_snapshots()
    if df.empty:
        return pd.DataFrame(columns=SNAPSHOT_HEADERS).set_index("종목")
    target = pd.Timestamp(date_).normalize()
    rows = df[df["날짜"].dt.normalize() == target].copy()
    rows = rows.drop(columns=["날짜"]).set_index("종목")
    return rows


def get_snapshot_at_or_before(as_of: datetime) -> tuple[datetime, pd.DataFrame] | None:
    """Most recent snapshot ≤ as_of. Returns (date, holdings_df) or None."""
    df = load_snapshots()
    if df.empty:
        return None
    as_of_ts = pd.Timestamp(as_of).normalize()
    valid = df[df["날짜"].dt.normalize() <= as_of_ts]
    if valid.empty:
        return None
    snap_date = valid["날짜"].max().normalize()
    rows = valid[valid["날짜"].dt.normalize() == snap_date].copy()
    rows = rows.drop(columns=["날짜"]).set_index("종목")
    return snap_date, rows


def get_latest_snapshot() -> pd.DataFrame:
    """Most recent snapshot, indexed by 종목. Empty df if none."""
    res = get_snapshot_at_or_before(datetime.now())
    if res is None:
        return pd.DataFrame(columns=["통화", "수량", "평균단가",
                                       "현재가", "환율", "평가액"])
    _, rows = res
    return rows


def save_snapshot(date_: datetime, rows: pd.DataFrame) -> dict:
    """Write rows as the snapshot for date_, overwriting any existing rows
    for that date.

    rows: DataFrame with columns 종목, 통화, 수량, 평균단가 (종목 may be index
    or column). 수량 == 0 행은 자동 제거.
    """
    target = pd.Timestamp(date_).normalize()
    target_str = target.strftime("%Y-%m-%d")

    df_existing = load_snapshots()
    keep = df_existing[df_existing["날짜"].dt.normalize() != target].copy()

    df_new = rows.reset_index() if rows.index.name == "종목" else rows.copy()
    df_new = df_new.copy()
    df_new["종목"] = df_new["종목"].astype(str).str.strip()
    df_new = df_new[df_new["종목"] != ""]
    df_new["수량"] = pd.to_numeric(df_new["수량"], errors="coerce").fillna(0.0)
    df_new["평균단가"] = pd.to_numeric(df_new["평균단가"], errors="coerce").fillna(0.0)
    df_new["통화"] = df_new["통화"].astype(str).str.strip().replace("", "KRW")
    # Optional price columns — preserve if present, else NaN
    for col in ("현재가", "환율", "평가액"):
        if col in df_new.columns:
            df_new[col] = pd.to_numeric(df_new[col], errors="coerce")
        else:
            df_new[col] = float("nan")
    df_new = df_new[df_new["수량"].abs() > 1e-9]
    df_new["날짜"] = target_str
    df_new = df_new[SNAPSHOT_HEADERS]

    combined = pd.concat([keep, df_new], ignore_index=True)
    combined["날짜"] = pd.to_datetime(combined["날짜"]).dt.strftime("%Y-%m-%d")
    combined = combined.sort_values(["날짜", "종목"]).reset_index(drop=True)
    sheets_db.write_tab("snapshots", combined)
    return {"status": "ok", "date": target_str, "rows": len(df_new)}


def delete_snapshot(date_: datetime) -> dict:
    target = pd.Timestamp(date_).normalize()
    df = load_snapshots()
    if df.empty:
        return {"status": "empty", "removed": 0}
    mask = df["날짜"].dt.normalize() == target
    removed = int(mask.sum())
    if removed == 0:
        return {"status": "no rows for date", "removed": 0}
    keep = df[~mask].copy()
    keep["날짜"] = keep["날짜"].dt.strftime("%Y-%m-%d")
    sheets_db.write_tab("snapshots", keep)
    return {"status": "ok", "removed": removed, "date": str(target.date())}


# ============== flows ==============

def load_flows() -> pd.DataFrame:
    """Signed external cash flows. + = 유입, − = 유출."""
    df = sheets_db.read_tab("flows")
    if df.empty:
        empty = pd.DataFrame(columns=FLOW_HEADERS)
        empty["날짜"] = pd.to_datetime(empty["날짜"])
        return empty
    df["날짜"] = pd.to_datetime(df["날짜"], errors="coerce")
    df["금액"] = pd.to_numeric(df["금액"], errors="coerce")
    df = df.dropna(subset=["날짜", "금액"])
    df["통화"] = df["통화"].astype(str).str.strip().replace("", "KRW")
    return df.sort_values("날짜").reset_index(drop=True)


def append_flow(date_: datetime, ccy: str, amount: float, memo: str = "") -> None:
    """Append a flow row. amount is signed."""
    row = {
        "날짜": pd.Timestamp(date_).strftime("%Y-%m-%d"),
        "통화": ccy,
        "금액": float(amount),
        "메모": memo,
    }
    sheets_db.append_row("flows", row)


def save_flows(df: pd.DataFrame) -> None:
    """Overwrite the entire flows tab."""
    out = df.copy()
    if "날짜" in out.columns:
        out["날짜"] = pd.to_datetime(out["날짜"]).dt.strftime("%Y-%m-%d")
    sheets_db.write_tab("flows", out[FLOW_HEADERS])


def flow_krw(row: pd.Series) -> float:
    """Convert one flow row to KRW using DEFAULT_FX (signed)."""
    ccy = row.get("통화") or "KRW"
    amt = float(row.get("금액", 0.0))
    fx = 1.0 if ccy == "KRW" else DEFAULT_FX.get(ccy, 1.0)
    return amt * fx


# ============== debt ==============

def load_debt_history() -> pd.DataFrame:
    df = sheets_db.read_tab("debt_history")
    if df.empty:
        empty = pd.DataFrame(columns=DEBT_HEADERS)
        empty["날짜"] = pd.to_datetime(empty["날짜"])
        return empty
    df["날짜"] = pd.to_datetime(df["날짜"], errors="coerce")
    df["부채"] = pd.to_numeric(df["부채"], errors="coerce")
    df = df.dropna(subset=["날짜", "부채"])
    return df.sort_values("날짜").reset_index(drop=True)


def upsert_debt(date_: datetime, debt: float, memo: str = "") -> dict:
    target = pd.Timestamp(date_).normalize()
    df = load_debt_history()
    if not df.empty:
        df = df[df["날짜"].dt.normalize() != target].copy()
    new_row = pd.DataFrame([{
        "날짜": target.strftime("%Y-%m-%d"),
        "부채": float(debt),
        "메모": memo,
    }])
    if df.empty:
        combined = new_row
    else:
        df["날짜"] = df["날짜"].dt.strftime("%Y-%m-%d")
        combined = pd.concat([df, new_row], ignore_index=True)
    combined = combined.sort_values("날짜").reset_index(drop=True)
    sheets_db.write_tab("debt_history", combined)
    return {"status": "ok", "date": target.strftime("%Y-%m-%d"), "부채": float(debt)}


def debt_at(date_: datetime, history: pd.DataFrame | None = None) -> float:
    """LOCF lookup."""
    h = history if history is not None else load_debt_history()
    if h.empty:
        return 0.0
    target = pd.Timestamp(date_).normalize()
    prior = h[h["날짜"].dt.normalize() <= target]
    return float(prior.iloc[-1]["부채"]) if not prior.empty else 0.0


# ============== nav_anchors (legacy historical NAV) ==============

def load_nav_anchors() -> pd.DataFrame:
    """User-input historical NAV anchor points (pre-snapshot era).
    Columns: 날짜, 총자산, 순자산, 좌수_총, 좌수_순, 기준가_총자산, 기준가_순자산.
    Used to backfill chart display + provide 좌수 starting point.
    """
    df = sheets_db.read_tab("nav_anchors")
    if df.empty:
        empty = pd.DataFrame(columns=NAV_ANCHOR_HEADERS)
        empty["날짜"] = pd.to_datetime(empty["날짜"])
        return empty
    df["날짜"] = pd.to_datetime(df["날짜"], errors="coerce")
    for col in ("총자산", "순자산", "좌수_총", "좌수_순",
                  "기준가_총자산", "기준가_순자산"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(subset=["날짜", "총자산"])
    return df.sort_values("날짜").reset_index(drop=True)


def save_nav_anchors(df: pd.DataFrame) -> None:
    """Overwrite nav_anchors tab."""
    out = df.copy()
    if "날짜" in out.columns:
        out["날짜"] = pd.to_datetime(out["날짜"]).dt.strftime("%Y-%m-%d")
    for h in NAV_ANCHOR_HEADERS:
        if h not in out.columns:
            out[h] = ""
    sheets_db.write_tab("nav_anchors", out[NAV_ANCHOR_HEADERS])


# ============== valuation ==============

def value_holdings(holdings: pd.DataFrame,
                    current_prices: dict[str, float],
                    fx_rates: dict[str, float]) -> pd.DataFrame:
    """Add 카테고리, 환율, 현재가, 평가액(원), 평가손익(원), 수익률.

    holdings: DataFrame indexed by 종목 with columns 통화, 수량, 평균단가.
    """
    if holdings.empty:
        return holdings.assign(카테고리="", 현재가=0.0, 평가액=0.0,
                                평가손익=0.0, 수익률=0.0, 환율=1.0)

    df = holdings.copy()
    cat_map = load_category_map()
    df["카테고리"] = df.index.map(lambda t: cat_map.get(t, "기타"))

    def _row_value(row):
        ticker = row.name
        ccy = row["통화"]
        fx = fx_rates.get(ccy, DEFAULT_FX.get(ccy, 1.0))
        if ticker in CASH_TICKERS or ticker in ACCOUNT_TICKERS:
            cur_price = 1.0
            value = row["수량"] * fx
        else:
            cur_price = current_prices.get(ticker, row["평균단가"])
            value = row["수량"] * cur_price * fx
        return cur_price, value, fx

    df[["현재가", "평가액", "환율"]] = df.apply(
        lambda r: pd.Series(_row_value(r)), axis=1)
    # cost basis at snapshot avg price (KRW, using current fx as approximation)
    df["원가"] = df["수량"] * df["평균단가"] * df["환율"]
    df["평가손익"] = df["평가액"] - df["원가"]
    df["수익률"] = np.where(df["원가"].abs() > 1e-6,
                            df["평가손익"] / df["원가"], 0.0)
    return df


def category_breakdown(valued: pd.DataFrame) -> pd.DataFrame:
    if valued.empty:
        return pd.DataFrame(columns=["카테고리", "평가액", "비중"])
    g = valued.groupby("카테고리")["평가액"].sum().reset_index()
    total = g["평가액"].sum()
    g["비중"] = g["평가액"] / total if total else 0
    return g.sort_values("평가액", ascending=False)


# ============== time series (NAV / 좌수 / 기준가) ==============

def _nav_at(snapshot: pd.DataFrame,
             d: pd.Timestamp,
             price_history: dict[str, pd.Series],
             fx_history: dict[str, pd.Series]) -> float:
    """Value of holdings (snapshot) using prices/fx on date d."""
    if snapshot.empty:
        return 0.0
    total = 0.0
    for ticker, row in snapshot.iterrows():
        ccy = row["통화"] or "KRW"
        qty = float(row["수량"])
        if ccy == "KRW":
            fx = 1.0
        else:
            fx_s = fx_history.get(ccy)
            if fx_s is not None and not fx_s.empty:
                idx = fx_s.index[fx_s.index <= d]
                fx = float(fx_s.loc[idx[-1]]) if len(idx) else DEFAULT_FX.get(ccy, 1.0)
            else:
                fx = DEFAULT_FX.get(ccy, 1.0)
        if ticker in CASH_TICKERS or ticker in ACCOUNT_TICKERS:
            total += qty * fx
        else:
            ph = price_history.get(ticker)
            if ph is not None and not ph.empty:
                idx = ph.index[ph.index <= d]
                price = float(ph.loc[idx[-1]]) if len(idx) else float(row["평균단가"])
            else:
                price = float(row["평균단가"])
            total += qty * price * fx
    return total


def compute_nav_history(snapshots_df: pd.DataFrame,
                          flows_df: pd.DataFrame,
                          debt_df: pd.DataFrame,
                          price_history: dict[str, pd.Series],
                          fx_history: dict[str, pd.Series],
                          nav_anchors_df: pd.DataFrame | None = None,
                          start: datetime | None = None,
                          end: datetime | None = None,
                          business_days_only: bool = True) -> pd.DataFrame:
    """Hybrid daily ledger: nav_anchors for past + snapshots×price for present.

    Day d:
      - NAV: if exact anchor on d, use anchor.총자산. Elif d < first snapshot
        date and any anchor ≤ d, LOCF from most recent anchor. Else derive
        from latest snapshot ≤ d × price(d) × fx(d).
      - 부채(d) = LOCF from debt_history
      - 좌수: anchor's 좌수 if exact match; else evolve from previous day's
        좌수 with flow_total / 기준가_prev. Initial 좌수 from oldest anchor
        with 좌수 set (= 1000 기준가 convention); fallback: nav/1000.
      - 기준가 = NAV / 좌수 (or use anchor.기준가 if exact match)

    Returns DataFrame: 날짜, 총자산, 순자산, 부채, 외부유입_총, 외부유입_순,
    좌수_총, 좌수_순, 기준가_총자산, 기준가_순자산.
    """
    cols = ["날짜", "총자산", "순자산", "부채", "외부유입_총", "외부유입_순",
             "좌수_총", "좌수_순", "기준가_총자산", "기준가_순자산"]

    has_snap = snapshots_df is not None and not snapshots_df.empty
    has_anchor = nav_anchors_df is not None and not nav_anchors_df.empty
    if not has_snap and not has_anchor:
        return pd.DataFrame(columns=cols)

    if has_snap:
        snap_sorted = snapshots_df.sort_values("날짜").copy()
        snap_dates_norm = snap_sorted["날짜"].dt.normalize()
        first_snap = snap_dates_norm.min()
        unique_snap_dates = sorted(snap_dates_norm.unique())
    else:
        snap_sorted = None
        snap_dates_norm = None
        first_snap = None
        unique_snap_dates = []

    # Determine overall start
    candidate_starts = []
    if has_anchor:
        candidate_starts.append(nav_anchors_df["날짜"].min().normalize())
    if has_snap:
        candidate_starts.append(first_snap)
    overall_start = min(candidate_starts)

    start = pd.Timestamp(start).normalize() if start is not None else overall_start
    end = pd.Timestamp(end).normalize() if end is not None else pd.Timestamp(datetime.now()).normalize()
    if end < start:
        return pd.DataFrame(columns=cols)

    if business_days_only:
        days = pd.bdate_range(start=start, end=end)
    else:
        days = pd.date_range(start=start, end=end, freq="D")
    if len(days) == 0:
        return pd.DataFrame(columns=cols)

    # Anchor lookup keyed by normalized date
    anchor_lookup: dict[pd.Timestamp, pd.Series] = {}
    sorted_anchor_dates: list[pd.Timestamp] = []
    if has_anchor:
        for _, r in nav_anchors_df.iterrows():
            d = pd.Timestamp(r["날짜"]).normalize()
            anchor_lookup[d] = r
        sorted_anchor_dates = sorted(anchor_lookup.keys())

    # Initial 좌수 from oldest anchor with 좌수_총 set
    initial_units_t = None
    initial_units_n = None
    if has_anchor:
        with_units = nav_anchors_df.dropna(subset=["좌수_총"])
        if not with_units.empty:
            initial_units_t = float(with_units.iloc[0]["좌수_총"])
            # if 좌수_순 missing, mirror 좌수_총
            units_n_val = with_units.iloc[0].get("좌수_순")
            initial_units_n = (float(units_n_val) if pd.notna(units_n_val)
                                else initial_units_t)

    # Flows aggregated by day (KRW signed)
    if flows_df is None or flows_df.empty:
        daily_flow = pd.Series(dtype=float)
    else:
        f = flows_df.copy()
        f["_krw"] = f.apply(flow_krw, axis=1)
        daily_flow = f.groupby(f["날짜"].dt.normalize())["_krw"].sum()

    def _holdings_at(d: pd.Timestamp) -> pd.DataFrame:
        if not has_snap:
            return pd.DataFrame(columns=["통화", "수량", "평균단가"])
        prior = [sd for sd in unique_snap_dates if sd <= d]
        if not prior:
            return pd.DataFrame(columns=["통화", "수량", "평균단가"])
        snap_d = prior[-1]
        sub = snap_sorted[snap_dates_norm == snap_d].copy()
        return sub.set_index("종목")[["통화", "수량", "평균단가"]]

    def _stored_nav_on_snapshot(d: pd.Timestamp) -> float | None:
        """If d is exactly a snapshot date and ALL rows have 평가액 set,
        return their sum. Otherwise None (caller will derive)."""
        if not has_snap or d not in [pd.Timestamp(x) for x in unique_snap_dates]:
            return None
        sub = snap_sorted[snap_dates_norm == d]
        if "평가액" not in sub.columns:
            return None
        vals = pd.to_numeric(sub["평가액"], errors="coerce")
        if vals.isna().any():
            return None
        return float(vals.sum())

    def _nav_for_day(d: pd.Timestamp) -> tuple[float, float | None]:
        """Returns (nav_total, nav_net_override).
        Priority: exact anchor > stored 평가액 (snapshot exact) > derive
        (snapshot ≤ d) > LOCF anchor > 0."""
        if d in anchor_lookup:
            anc = anchor_lookup[d]
            net = float(anc["순자산"]) if pd.notna(anc.get("순자산")) else None
            return float(anc["총자산"]), net
        stored = _stored_nav_on_snapshot(d)
        if stored is not None:
            return stored, None
        if has_snap and d >= first_snap:
            holdings = _holdings_at(d)
            return _nav_at(holdings, d, price_history, fx_history), None
        # LOCF from anchors (pre-snapshot gap)
        prior = [ad for ad in sorted_anchor_dates if ad <= d]
        if prior:
            anc = anchor_lookup[prior[-1]]
            net = float(anc["순자산"]) if pd.notna(anc.get("순자산")) else None
            return float(anc["총자산"]), net
        return 0.0, None

    rows = []
    units_t = 0.0
    units_n = 0.0
    prev_debt = 0.0

    for i, d in enumerate(days):
        nav_t, nav_n_override = _nav_for_day(d)
        debt_today = debt_at(d, history=debt_df)
        if nav_n_override is not None:
            nav_n = nav_n_override
            # Reverse-engineer implicit debt for this row so 좌수_순 evolution is consistent
            debt_today = nav_t - nav_n
        else:
            nav_n = nav_t - debt_today
        flow_t = float(daily_flow.get(d, 0.0))
        debt_change = debt_today - prev_debt if i > 0 else 0.0
        flow_n = flow_t - debt_change

        if i == 0:
            # Initialize 좌수
            if initial_units_t is not None:
                units_t = initial_units_t
                units_n = initial_units_n if initial_units_n is not None else initial_units_t
            elif nav_t > 0:
                # 기준가 starts at 1000 convention
                units_t = nav_t / 1000.0
                units_n = nav_n / 1000.0 if nav_n > 0 else units_t
            else:
                units_t = 0.0
                units_n = 0.0
            up_t = (nav_t / units_t) if units_t > 0 else 0.0
            up_n = (nav_n / units_n) if units_n > 0 else 0.0
        else:
            prev = rows[-1]
            if flow_t != 0 and prev["기준가_총자산"] > 0:
                units_t += flow_t / prev["기준가_총자산"]
            if flow_n != 0 and prev["기준가_순자산"] > 0:
                units_n += flow_n / prev["기준가_순자산"]
            up_t = (nav_t / units_t) if units_t > 0 else 0.0
            up_n = (nav_n / units_n) if units_n > 0 else 0.0

        # Override with anchor's explicit 좌수/기준가 if present
        if d in anchor_lookup:
            anc = anchor_lookup[d]
            if pd.notna(anc.get("좌수_총")):
                units_t = float(anc["좌수_총"])
                up_t = (nav_t / units_t) if units_t > 0 else 0.0
            if pd.notna(anc.get("좌수_순")):
                units_n = float(anc["좌수_순"])
                up_n = (nav_n / units_n) if units_n > 0 else 0.0
            if pd.notna(anc.get("기준가_총자산")):
                up_t = float(anc["기준가_총자산"])
            if pd.notna(anc.get("기준가_순자산")):
                up_n = float(anc["기준가_순자산"])

        rows.append({
            "날짜": d, "총자산": nav_t, "순자산": nav_n, "부채": debt_today,
            "외부유입_총": flow_t if i > 0 else 0.0,
            "외부유입_순": flow_n if i > 0 else 0.0,
            "좌수_총": units_t, "좌수_순": units_n,
            "기준가_총자산": up_t, "기준가_순자산": up_n,
        })
        prev_debt = debt_today

    return pd.DataFrame(rows, columns=cols)


def compute_income_summary(nav_history: pd.DataFrame,
                             flows_df: pd.DataFrame,
                             today: datetime | None = None) -> dict:
    """누적·YTD 금융수익금 from nav_history + flows. **순자산 baseline**.

    누적 금융수익금 = NAV_순[now] − NAV_순[start] − Σ external_flows
    YTD          = NAV_순[now] − NAV_순[연초 직전 영업일] − Σ flows (연초 이후)
    % = cum_income / NAV_순[start] (= 시작 시드머니 대비 운용 성과)
    부채 변동은 flows의 flow_n에서 자동 캔슬됨 (총·순 동일).
    """
    if nav_history is None or nav_history.empty:
        return {"status": "no nav history"}

    today = pd.Timestamp(today or datetime.now()).normalize()
    h = nav_history.copy()
    h["날짜"] = pd.to_datetime(h["날짜"]).dt.normalize()
    h = h[h["날짜"] <= today].sort_values("날짜")
    if h.empty:
        return {"status": "no rows ≤ today"}

    start_row = h.iloc[0]
    last_row = h.iloc[-1]
    start_date = start_row["날짜"]
    nav_now_total = float(last_row["총자산"])
    nav_now_net = float(last_row["순자산"])
    nav_start_total = float(start_row["총자산"])
    nav_start_net = float(start_row["순자산"])

    year_anchor_date = None
    year_anchor_nav_net = None
    if flows_df is None or flows_df.empty:
        flow_krw_total = 0.0
        flow_krw_ytd = 0.0
    else:
        f = flows_df.copy()
        f["_krw"] = f.apply(flow_krw, axis=1)
        f_norm = f["날짜"].dt.normalize()
        flow_krw_total = float(f.loc[(f_norm > start_date) & (f_norm <= today), "_krw"].sum())

        year_start = pd.Timestamp(today.year, 1, 1)
        h_pre = h[h["날짜"] < year_start]
        if not h_pre.empty:
            year_anchor_date = h_pre.iloc[-1]["날짜"]
            year_anchor_nav_net = float(h_pre.iloc[-1]["순자산"])
            flow_krw_ytd = float(f.loc[(f_norm > year_anchor_date) & (f_norm <= today), "_krw"].sum())
        else:
            flow_krw_ytd = None

    # YTD anchor — even if no flows, need year_anchor_nav from history
    if year_anchor_nav_net is None:
        year_start = pd.Timestamp(today.year, 1, 1)
        h_pre = h[h["날짜"] < year_start]
        if not h_pre.empty:
            year_anchor_date = h_pre.iloc[-1]["날짜"]
            year_anchor_nav_net = float(h_pre.iloc[-1]["순자산"])

    cum_income = nav_now_net - nav_start_net - flow_krw_total

    ytd_income = None
    if year_anchor_nav_net is not None:
        ytd_income = nav_now_net - year_anchor_nav_net - (flow_krw_ytd or 0.0)

    debt_now = float(last_row["부채"])
    return {
        "start_date": str(start_date.date()),
        "start_nav_net": nav_start_net,
        "start_nav_total": nav_start_total,
        "current_nav_total": nav_now_total,
        "current_nav_net": nav_now_net,
        "debt_now": debt_now,
        "cum_inflow": flow_krw_total,
        "cum_income": cum_income,
        "ytd_income": ytd_income,
        "year": today.year,
        "year_anchor_date": str(year_anchor_date.date()) if year_anchor_date is not None else None,
        "year_anchor_nav_net": year_anchor_nav_net,
    }
