"""One-shot: import old `net_asset_history.csv` (backup) into the new
`nav_anchors` tab. Used to seed pre-snapshot 자산 추이 for the chart and
좌수/기준가 starting point.

Source CSV columns: 날짜, 총자산, 순자산, 기준가_총자산, 기준가_순자산, 좌수
Target tab columns: 날짜, 총자산, 순자산, 좌수_총, 좌수_순, 기준가_총자산, 기준가_순자산
(좌수 → 좌수_총, 좌수_순 mirrors 좌수_총 since old CSV had only one.)
"""
from __future__ import annotations
import sys
from pathlib import Path

import pandas as pd

import sheets_db
from portfolio import save_nav_anchors

DEFAULT_CSV = Path(r"C:\Users\공도일\Desktop\코딩\portfolio-monitor\data\net_asset_history.csv")


def main(csv_path: Path = DEFAULT_CSV):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if not csv_path.exists():
        print(f"❌ CSV not found: {csv_path}")
        return

    print(f"Reading {csv_path}...")
    df = pd.read_csv(csv_path)
    print(f"  → {len(df)} rows, columns: {list(df.columns)}")

    df["날짜"] = pd.to_datetime(df["날짜"], errors="coerce")
    df = df.dropna(subset=["날짜", "총자산"]).copy()

    for col in ("총자산", "순자산", "기준가_총자산", "기준가_순자산"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        else:
            df[col] = float("nan")

    # 좌수_총: 옛 CSV의 "좌수" 컬럼 그대로
    if "좌수" in df.columns:
        df["좌수_총"] = pd.to_numeric(df["좌수"], errors="coerce")
    else:
        df["좌수_총"] = float("nan")

    # 좌수_순: NAV_순 / 기준가_순으로 역산 (옛 CSV는 좌수 한 종류였지만
    # 사용자가 기준가_순을 별도로 계산했었음 → 진짜 좌수_순은 다르다)
    mask = df["기준가_순자산"].notna() & df["순자산"].notna() & (df["기준가_순자산"] > 0)
    df["좌수_순"] = float("nan")
    df.loc[mask, "좌수_순"] = df.loc[mask, "순자산"] / df.loc[mask, "기준가_순자산"]

    # 첫 anchor (기준가_순 빈 칸) → 다음 anchor의 좌수_순으로 backward fill
    # + 그 좌수_순으로 첫 anchor의 기준가_순도 derive
    df_sorted = df.sort_values("날짜").reset_index(drop=True)
    first_valid = df_sorted["좌수_순"].first_valid_index()
    if first_valid is not None and first_valid > 0:
        fill_val = df_sorted.loc[first_valid, "좌수_순"]
        df_sorted.loc[:first_valid-1, "좌수_순"] = fill_val
        m2 = (df_sorted["기준가_순자산"].isna()
              & df_sorted["좌수_순"].notna() & (df_sorted["좌수_순"] > 0)
              & df_sorted["순자산"].notna())
        df_sorted.loc[m2, "기준가_순자산"] = (
            df_sorted.loc[m2, "순자산"] / df_sorted.loc[m2, "좌수_순"])
    df = df_sorted

    out = df[["날짜", "총자산", "순자산", "좌수_총", "좌수_순",
                "기준가_총자산", "기준가_순자산"]].copy()
    out = out.sort_values("날짜").reset_index(drop=True)

    print(f"\nWriting to nav_anchors tab ({len(out)} rows)...")
    sheets_db.ensure_all_tabs()  # make sure nav_anchors exists
    save_nav_anchors(out)
    print("✅ Done.")
    print(f"\nFirst 3 rows:")
    print(out.head(3).to_string(index=False))
    print(f"\nLast 3 rows:")
    print(out.tail(3).to_string(index=False))


if __name__ == "__main__":
    main()
