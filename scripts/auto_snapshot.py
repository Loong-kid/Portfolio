"""매일 자동 스냅샷 — GitHub Actions(.github/workflows/daily-snapshot.yml)에서 실행.

실행 시각: UTC 16:07 월~금 = KST 01:07 화~토.
  미국장 개장(KST 22:30 서머타임 / 23:30 겨울) 후 1.5~2.5시간, 한국장은 그날 종가.

날짜 라벨 = 미국 거래일 (= 실행 시점의 UTC 날짜 = KST 날짜 − 1).
  KST 화요일 01:07에 찍은 값은 "월요일 한국 종가 + 월요일 미국장 중간"이므로 월요일로 기록.

동작:
  1. 라벨 날짜 이하 가장 최근 스냅샷의 수량/평균단가/통화를 그대로 가져옴
  2. 현재가/환율만 새로 fetch → 평가액 계산 → 그 날짜 스냅샷으로 저장 (있으면 덮어씀)

안전장치 (하나라도 걸리면 저장 안 하고 exit 1 → GitHub이 실패 메일 발송):
  - 필요한 외화 환율 fetch 실패 (DEFAULT_FX 같은 고정값으로 저장하지 않음)
  - 주식 가격이 전부 fetch 실패
  - 총 평가액이 기준 스냅샷 대비 ±30% 초과 변동 (데이터 오류 의심, --force로 무시)
  일부 종목만 실패하면 기준 스냅샷의 현재가로 채우고 경고만 출력.

로컬 테스트:
  ./.venv/Scripts/python.exe scripts/auto_snapshot.py --dry-run
"""
from __future__ import annotations
import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import pandas as pd
import yfinance as yf

from config import FX_TICKERS, PORTFOLIO_NAME
from data_fetcher import get_current_price
from portfolio import (ACCOUNT_TICKERS, CASH_TICKERS,
                       get_snapshot_at_or_before, save_snapshot)

MAX_TOTAL_CHANGE = 0.30


def _fetch_fx(ccy: str) -> float | None:
    symbol = FX_TICKERS.get(ccy)
    if not symbol:
        return None
    try:
        df = yf.Ticker(symbol).history(period="5d", auto_adjust=False)
        close = df["Close"].dropna()
        return float(close.iloc[-1]) if not close.empty else None
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="라벨 날짜 YYYY-MM-DD (기본: 오늘 UTC 날짜)")
    ap.add_argument("--dry-run", action="store_true", help="시트에 저장하지 않음")
    ap.add_argument("--force", action="store_true", help=f"±{MAX_TOTAL_CHANGE:.0%} 변동 검사 무시")
    args = ap.parse_args()

    label = (pd.Timestamp(args.date) if args.date
             else pd.Timestamp(datetime.now(timezone.utc).date()))
    print(f"[{PORTFOLIO_NAME}] 스냅샷 날짜 {label.date()}"
          f"{' (dry-run)' if args.dry_run else ''}")

    res = get_snapshot_at_or_before(label)
    if res is None:
        print("❌ 기준 스냅샷 없음 — 수동으로 첫 스냅샷을 먼저 만들어야 함")
        return 1
    base_date, base = res
    print(f"기준 스냅샷: {base_date.date()} ({len(base)}종목)")

    # 환율
    fx: dict[str, float] = {"KRW": 1.0}
    for ccy in sorted(set(base["통화"]) - {"KRW"}):
        rate = _fetch_fx(ccy)
        if rate is None or rate <= 0:
            print(f"❌ {ccy} 환율 fetch 실패 — 저장 중단")
            return 1
        fx[ccy] = rate
        print(f"  환율 {ccy}: {rate:,.2f}")

    rows = []
    fallback, fetched = [], 0
    for ticker, r in base.iterrows():
        ccy = r["통화"]
        qty = float(pd.to_numeric(r["수량"], errors="coerce") or 0.0)
        if ticker in CASH_TICKERS or ticker in ACCOUNT_TICKERS:
            price = 1.0
        else:
            price = get_current_price(ticker)
            if price is not None and price > 0:
                fetched += 1
            else:
                prev = pd.to_numeric(r.get("현재가"), errors="coerce")
                price = float(prev) if pd.notna(prev) and prev > 0 else float("nan")
                fallback.append(ticker)
        rows.append({
            "종목": ticker, "통화": ccy, "수량": qty,
            "평균단가": r["평균단가"], "현재가": price, "환율": fx[ccy],
            "평가액": qty * price * fx[ccy],
        })
    new = pd.DataFrame(rows)

    stocks = [t for t in base.index if t not in CASH_TICKERS | ACCOUNT_TICKERS]
    if stocks and fetched == 0:
        print("❌ 모든 종목 가격 fetch 실패 — 저장 중단")
        return 1
    if fallback:
        print(f"⚠️ 가격 fetch 실패 → 기준 스냅샷 가격 사용: {', '.join(fallback)}")

    total = new["평가액"].sum()
    base_total = pd.to_numeric(base["평가액"], errors="coerce").sum()
    print(f"총 평가액 ₩{total:,.0f} (기준 ₩{base_total:,.0f})")
    if base_total > 0:
        change = total / base_total - 1
        print(f"  변동 {change:+.2%}")
        if abs(change) > MAX_TOTAL_CHANGE and not args.force:
            print(f"❌ ±{MAX_TOTAL_CHANGE:.0%} 초과 변동 — 데이터 오류 의심, 저장 중단 (--force로 무시)")
            return 1

    print(new.to_string(index=False))
    if args.dry_run:
        print("dry-run — 저장 안 함")
        return 0
    out = save_snapshot(label, new)
    print(f"✅ 저장: {out['date']} {out['rows']}행")
    return 0


if __name__ == "__main__":
    sys.exit(main())
