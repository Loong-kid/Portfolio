"""Config for the cloud (Sheets-only) variant.

값 우선순위: st.secrets > .env > default
Streamlit Cloud 배포 시 secrets, 로컬은 .env 사용.
"""
from pathlib import Path
import os
from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).parent


def _secret(key: str, default: str = "") -> str:
    """st.secrets 우선, 없으면 env, 없으면 default."""
    try:
        import streamlit as st
        # st.secrets에서 직접 .get() — KeyError/FileNotFoundError 안 던짐
        v = None
        if hasattr(st, "secrets"):
            try:
                v = st.secrets.get(key)
            except (FileNotFoundError, AttributeError):
                v = None
        if v is not None and str(v).strip():
            return str(v).strip()
    except Exception:
        pass
    return (os.environ.get(key) or default).strip()


GOOGLE_SA_JSON = _secret("GOOGLE_SA_JSON")     # 로컬: file path. Cloud: 사용 안 함 (gcp_service_account dict 직접)
GOOGLE_SHEET_ID = _secret("GOOGLE_SHEET_ID")
PORTFOLIO_NAME = _secret("PORTFOLIO_NAME") or "도일"

DEFAULT_FX = {"KRW": 1.0, "USD": 1520.0, "EUR": 1763.0, "JPY": 9.53}
FX_TICKERS = {"USD": "USDKRW=X", "EUR": "EURKRW=X", "JPY": "JPYKRW=X"}


# ============== Category / Ticker mapping (Sheets-backed) ==============

def load_category_map() -> dict[str, str]:
    """종목→카테고리 매핑 from 'categories' tab."""
    import sheets_db
    df = sheets_db.read_tab("categories")
    out: dict[str, str] = {}
    for _, row in df.iterrows():
        t = str(row.get("종목", "")).strip()
        c = str(row.get("카테고리", "")).strip()
        if t:
            out[t] = c
    return out


def save_category_map(mapping: dict[str, str]) -> None:
    import sheets_db
    import pandas as pd
    rows = [{"종목": k, "카테고리": v} for k, v in sorted(mapping.items())]
    df = pd.DataFrame(rows, columns=["종목", "카테고리"])
    sheets_db.write_tab("categories", df)


def load_ticker_map() -> dict[str, str]:
    import sheets_db
    df = sheets_db.read_tab("ticker_map")
    out: dict[str, str] = {}
    for _, row in df.iterrows():
        t = str(row.get("종목", "")).strip()
        s = str(row.get("yfinance_symbol", "")).strip()
        if t:
            out[t] = s
    return out


def save_ticker_map(mapping: dict[str, str]) -> None:
    import sheets_db
    import pandas as pd
    rows = [{"종목": k, "yfinance_symbol": v} for k, v in sorted(mapping.items())]
    df = pd.DataFrame(rows, columns=["종목", "yfinance_symbol"])
    sheets_db.write_tab("ticker_map", df)
