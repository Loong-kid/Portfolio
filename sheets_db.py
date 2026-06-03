"""Google Sheets-backed data store (snapshot-primary architecture).

Tabs:
  snapshots       — 날짜별 보유 상태 (truth)
  flows           — 외부 자금 유입/유출 (좌수/기준가 계산용)
  debt_history    — 부채 LOCF 시계열
  stock_notes     — 보유 종목 목표가/메모
  watchlist       — 관찰 종목 목표가/메모 (비보유)
  categories      — 종목→카테고리 매핑
  ticker_map      — 종목→yfinance 심볼 매핑
  portfolio_order — 메인 표 정렬 순서
"""
from __future__ import annotations
import os
import time
import pandas as pd

CACHE_TTL = 60  # seconds — read cache

SCHEMAS: dict[str, list[str]] = {
    "snapshots":       ["날짜", "종목", "통화", "수량", "평균단가", "현재가", "환율", "평가액"],
    "flows":           ["날짜", "통화", "금액", "메모"],
    "debt_history":    ["날짜", "부채", "메모"],
    "nav_anchors":     ["날짜", "총자산", "순자산", "좌수_총", "좌수_순", "기준가_총자산", "기준가_순자산"],
    "stock_notes":     ["종목", "목표가_상단", "목표가_하단", "업사이드_메모", "다운사이드_메모", "업데이트일"],
    "watchlist":       ["종목", "통화", "목표가_상단", "목표가_하단", "업사이드_메모", "다운사이드_메모", "업데이트일"],
    "categories":      ["종목", "카테고리"],
    "ticker_map":      ["종목", "yfinance_symbol"],
    "portfolio_order": ["종목", "순서"],
}

_cache: dict[str, tuple[float, pd.DataFrame]] = {}
_client_singleton = None
_sheet_singleton = None


def _get_client():
    """Resolve gspread client.

    Priority:
      1. st.secrets["gcp_service_account"] — Streamlit Cloud (dict)
      2. GOOGLE_SA_JSON file path — local dev (.env)
    """
    global _client_singleton
    if _client_singleton is None:
        import gspread
        # Cloud: secrets dict
        try:
            import streamlit as st
            sa = st.secrets.get("gcp_service_account") if hasattr(st, "secrets") else None
            if sa:
                _client_singleton = gspread.service_account_from_dict(dict(sa))
                return _client_singleton
        except Exception:
            pass
        # Local: file path
        from config import GOOGLE_SA_JSON
        if not GOOGLE_SA_JSON or not os.path.exists(GOOGLE_SA_JSON):
            raise RuntimeError(
                f"인증 정보 없음. 로컬: .env의 GOOGLE_SA_JSON 파일경로 / "
                f"Cloud: secrets의 [gcp_service_account] 섹션 필요. "
                f"현재 GOOGLE_SA_JSON={GOOGLE_SA_JSON!r}"
            )
        _client_singleton = gspread.service_account(filename=GOOGLE_SA_JSON)
    return _client_singleton


def _get_sheet():
    global _sheet_singleton
    if _sheet_singleton is None:
        from config import GOOGLE_SHEET_ID
        if not GOOGLE_SHEET_ID:
            raise RuntimeError("GOOGLE_SHEET_ID not set (.env)")
        _sheet_singleton = _get_client().open_by_key(GOOGLE_SHEET_ID)
    return _sheet_singleton


def _get_ws(tab_name: str, headers: list[str] | None = None):
    """Return worksheet, creating with headers if missing."""
    sh = _get_sheet()
    try:
        return sh.worksheet(tab_name)
    except Exception:
        cols = max(len(headers or []), 10)
        ws = sh.add_worksheet(tab_name, rows=200, cols=cols)
        if headers:
            ws.update(values=[headers], range_name="A1",
                      value_input_option="USER_ENTERED")
            ws.freeze(rows=1)
        return ws


def _format_val(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and pd.isna(v):
        return ""
    return str(v)


# ============== Public API ==============

def read_tab(tab_name: str, *, no_cache: bool = False) -> pd.DataFrame:
    headers = SCHEMAS.get(tab_name)
    now = time.time()
    if not no_cache and tab_name in _cache:
        ts, df = _cache[tab_name]
        if now - ts < CACHE_TTL:
            return df.copy()
    ws = _get_ws(tab_name, headers=headers)
    rows = ws.get_all_values()
    if not rows:
        df = pd.DataFrame(columns=headers or [])
    else:
        cols = rows[0]
        data = rows[1:]
        df = pd.DataFrame(data, columns=cols)
        if headers:
            for h in headers:
                if h not in df.columns:
                    df[h] = ""
            df = df[headers]
    _cache[tab_name] = (now, df)
    return df.copy()


def write_tab(tab_name: str, df: pd.DataFrame) -> None:
    headers = SCHEMAS.get(tab_name)
    ws = _get_ws(tab_name, headers=headers)
    if headers:
        df = df.copy()
        for h in headers:
            if h not in df.columns:
                df[h] = ""
        df = df[headers]
    cols = list(df.columns)
    body = [[_format_val(v) for v in row] for row in df.values.tolist()]
    ws.clear()
    ws.update(values=[cols] + body, range_name="A1",
              value_input_option="USER_ENTERED")
    invalidate_cache(tab_name)


def append_row(tab_name: str, row: dict) -> None:
    headers = SCHEMAS.get(tab_name)
    ws = _get_ws(tab_name, headers=headers)
    existing_headers = ws.row_values(1)
    if not existing_headers and headers:
        ws.update(values=[headers], range_name="A1",
                  value_input_option="USER_ENTERED")
        existing_headers = headers
    values = [_format_val(row.get(h, "")) for h in existing_headers]
    ws.append_row(values, value_input_option="USER_ENTERED")
    invalidate_cache(tab_name)


def invalidate_cache(tab_name: str | None = None) -> None:
    if tab_name is None:
        _cache.clear()
    else:
        _cache.pop(tab_name, None)


def delete_tab(tab_name: str) -> str:
    """Delete a worksheet entirely. Returns status string."""
    sh = _get_sheet()
    try:
        ws = sh.worksheet(tab_name)
    except Exception:
        return "not found"
    sh.del_worksheet(ws)
    invalidate_cache(tab_name)
    return "deleted"


def list_tabs() -> list[str]:
    return [ws.title for ws in _get_sheet().worksheets()]


def ensure_all_tabs() -> dict:
    """Make sure every schema tab exists with proper headers."""
    out = {}
    for tab, headers in SCHEMAS.items():
        ws = _get_ws(tab, headers=headers)
        existing = ws.row_values(1)
        if not existing:
            ws.update(values=[headers], range_name="A1",
                      value_input_option="USER_ENTERED")
            out[tab] = "created with headers"
            invalidate_cache(tab)
            continue
        missing = [h for h in headers if h not in existing]
        if missing:
            new_headers = existing + missing
            ws.update(values=[new_headers], range_name="A1",
                      value_input_option="USER_ENTERED")
            out[tab] = f"added columns: {missing}"
            invalidate_cache(tab)
        else:
            out[tab] = "exists"
    return out
