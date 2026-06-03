"""One-time migration: transactions-primary → snapshot-primary.

What it does:
  1. Reads the old `transactions` tab (if any) and replays it to compute
     today's holdings.
  2. Writes those holdings as today's snapshot in the new `snapshots` tab.
  3. Migrates the latest `부채` value (if any) from old `net_asset_history`
     into the new `debt_history` tab.
  4. Deletes all obsolete tabs: transactions, balance_snapshot,
     net_asset_history, Balance sheet daily, Balance sheet(history).
  5. Ensures new tabs exist: snapshots, flows, debt_history, +unchanged ones.

Run once after upgrading. Idempotent for the new tabs (will skip seeding if
snapshots tab already has a row for today).

Usage:
    python migrate_to_snapshot.py
    python migrate_to_snapshot.py --dry-run   # show plan without executing

Encoding fix for Windows console:
    set PYTHONIOENCODING=utf-8
"""
from __future__ import annotations
import argparse
import sys
from collections import defaultdict
from datetime import datetime

import pandas as pd

import sheets_db
from config import DEFAULT_FX
from portfolio import (
    save_snapshot, upsert_debt,
    CASH_TICKERS, ACCOUNT_TICKERS,
)

OBSOLETE_TABS = [
    "transactions",
    "balance_snapshot",
    "net_asset_history",
    "Balance sheet daily",
    "Balance sheet(history)",
]


def _read_old_tab(name: str) -> pd.DataFrame:
    """Read a non-schema'd tab. Returns empty df if missing."""
    try:
        sh = sheets_db._get_sheet()
        ws = sh.worksheet(name)
        rows = ws.get_all_values()
        if not rows or len(rows) < 2:
            return pd.DataFrame()
        return pd.DataFrame(rows[1:], columns=rows[0])
    except Exception:
        return pd.DataFrame()


def _fx_at(row) -> float:
    ccy = (row.get("통화") or "KRW").strip() or "KRW"
    if ccy == "KRW":
        return 1.0
    try:
        v = float(row.get("환율") or 0)
        if v > 0:
            return v
    except (ValueError, TypeError):
        pass
    return DEFAULT_FX.get(ccy, 1.0)


def _replay_transactions(tx: pd.DataFrame) -> pd.DataFrame:
    """Mini replay matching the OLD engine. Output: rows with 종목, 통화,
    수량, 평균단가 (current state)."""
    if tx.empty:
        return pd.DataFrame(columns=["종목", "통화", "수량", "평균단가"])

    tx = tx.copy()
    tx["날짜"] = pd.to_datetime(tx.get("날짜"), errors="coerce")
    for col in ("수량", "단가", "환율", "수수료"):
        if col in tx.columns:
            tx[col] = pd.to_numeric(tx[col], errors="coerce")
    tx = tx.dropna(subset=["날짜"]).sort_values("날짜").reset_index(drop=True)

    h: dict[str, dict] = defaultdict(lambda: {
        "수량": 0.0, "평균단가": 0.0, "통화": "KRW",
    })

    for _, r in tx.iterrows():
        action = (r.get("유형") or "").strip()
        ticker = (r.get("종목") or "").strip()
        qty = r.get("수량") if pd.notna(r.get("수량")) else 0.0
        price = r.get("단가") if pd.notna(r.get("단가")) else 0.0
        fx = _fx_at(r)

        if action == "환전":
            if ticker and "→" in ticker:
                src, tgt = ticker.split("→", 1)
                src_amt = float(price)
                tgt_amt = float(qty)
                src_ccy = src.replace("현금", "") or "KRW"
                tgt_ccy = tgt.replace("현금", "") or "KRW"
                sh = h[src]; sh["통화"] = src_ccy
                sh["수량"] -= src_amt; sh["평균단가"] = 1.0
                th = h[tgt]; th["통화"] = tgt_ccy
                th["수량"] += tgt_amt; th["평균단가"] = 1.0
            continue

        if not ticker:
            continue
        rh = h[ticker]
        rh["통화"] = (r.get("통화") or "KRW").strip() or "KRW"

        if action == "시작잔고":
            if ticker in CASH_TICKERS or ticker in ACCOUNT_TICKERS:
                rh["수량"] = float(price)
                rh["평균단가"] = 1.0
            else:
                rh["수량"] = float(qty)
                rh["평균단가"] = float(price)
        elif action == "매수":
            new_qty = rh["수량"] + float(qty)
            if new_qty > 0:
                rh["평균단가"] = (rh["수량"] * rh["평균단가"]
                                  + float(qty) * float(price)) / new_qty
            rh["수량"] = new_qty
        elif action == "매도":
            rh["수량"] -= float(qty)
            if rh["수량"] <= 1e-9:
                rh["수량"] = 0.0
        elif action == "배당":
            cash_key = f"{rh['통화']}현금"
            ch = h[cash_key]; ch["통화"] = rh["통화"]
            ch["수량"] += float(price); ch["평균단가"] = 1.0
        elif action == "입금":
            if ticker in (CASH_TICKERS | ACCOUNT_TICKERS):
                ccy_eff = ("KRW" if ticker in ACCOUNT_TICKERS
                            else (ticker.replace("현금", "") or "KRW"))
                ch = h[ticker]
            else:
                ccy_eff = rh["통화"]
                ch = h[f"{ccy_eff}현금"]
            ch["통화"] = ccy_eff
            ch["수량"] += float(price); ch["평균단가"] = 1.0
        elif action == "출금":
            if ticker in (CASH_TICKERS | ACCOUNT_TICKERS):
                ccy_eff = ("KRW" if ticker in ACCOUNT_TICKERS
                            else (ticker.replace("현금", "") or "KRW"))
                ch = h[ticker]
            else:
                ccy_eff = rh["통화"]
                ch = h[f"{ccy_eff}현금"]
            ch["통화"] = ccy_eff
            ch["수량"] -= float(price); ch["평균단가"] = 1.0
        elif action == "조정":
            if ticker in (CASH_TICKERS | ACCOUNT_TICKERS):
                ccy_eff = ("KRW" if ticker in ACCOUNT_TICKERS
                            else (ticker.replace("현금", "") or "KRW"))
                ch = h[ticker]; ch["통화"] = ccy_eff
                ch["수량"] += float(price); ch["평균단가"] = 1.0
        elif action == "단가조정":
            if ticker not in (CASH_TICKERS | ACCOUNT_TICKERS):
                rh["평균단가"] = float(price)

    rows = []
    for ticker, v in h.items():
        if abs(v["수량"]) < 1e-9:
            continue
        rows.append({
            "종목": ticker, "통화": v["통화"],
            "수량": v["수량"], "평균단가": v["평균단가"],
        })
    return pd.DataFrame(rows, columns=["종목", "통화", "수량", "평균단가"])


def main(dry_run: bool = False):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    print("=" * 60)
    print("Migration: transactions-primary → snapshot-primary")
    print("=" * 60)

    # ----- Step 1: ensure new schema tabs exist
    print("\n[1/4] Ensuring new schema tabs exist...")
    if not dry_run:
        sheets_db.ensure_all_tabs()
        print("  → snapshots / flows / debt_history / categories / "
              "ticker_map / portfolio_order / stock_notes")
    else:
        print("  (dry-run, skipped)")

    # ----- Step 2: replay old transactions
    print("\n[2/4] Reading old `transactions` tab...")
    tx = _read_old_tab("transactions")
    if tx.empty:
        print("  → No old transactions found. Skipping snapshot seed.")
        seeded = False
    else:
        print(f"  → Found {len(tx)} transaction rows.")
        holdings = _replay_transactions(tx)
        print(f"  → Replayed to {len(holdings)} non-zero positions.")
        if dry_run:
            print(holdings.to_string(index=False))
            seeded = False
        else:
            today = datetime.now()
            res = save_snapshot(today, holdings)
            print(f"  → Saved today's snapshot: {res}")
            seeded = True

    # ----- Step 3: migrate latest 부채 from old net_asset_history
    print("\n[3/4] Migrating latest 부채 from old `net_asset_history`...")
    nh = _read_old_tab("net_asset_history")
    if nh.empty or "부채" not in nh.columns:
        print("  → No 부채 history found.")
    else:
        nh["날짜"] = pd.to_datetime(nh["날짜"], errors="coerce")
        nh["부채"] = pd.to_numeric(nh["부채"], errors="coerce")
        nh = nh.dropna(subset=["날짜", "부채"]).sort_values("날짜")
        if nh.empty:
            print("  → No valid 부채 rows.")
        else:
            last = nh.iloc[-1]
            print(f"  → Last 부채: {last['날짜'].date()} → "
                  f"₩{last['부채']:,.0f}")
            if not dry_run:
                res = upsert_debt(last["날짜"], float(last["부채"]),
                                   memo="migrated from net_asset_history")
                print(f"  → {res}")

    # ----- Step 4: delete obsolete tabs
    print("\n[4/4] Deleting obsolete tabs...")
    existing = sheets_db.list_tabs() if not dry_run else []
    for name in OBSOLETE_TABS:
        if dry_run:
            print(f"  - {name}: (dry-run)")
            continue
        if name not in existing:
            print(f"  - {name}: not present")
            continue
        status = sheets_db.delete_tab(name)
        print(f"  - {name}: {status}")

    print("\n" + "=" * 60)
    if dry_run:
        print("Dry run complete. Re-run without --dry-run to apply.")
    else:
        print("Migration complete.")
        if seeded:
            print("→ Today's snapshot has been seeded from old transactions.")
        print("→ Run `streamlit run app.py` and verify the 💼 현재 포트폴리오 "
              "looks correct. Edit the snapshot in 📸 스냅샷 탭 if needed.")
    print("=" * 60)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true",
                          help="Show plan without executing.")
    args = parser.parse_args()
    main(dry_run=args.dry_run)
