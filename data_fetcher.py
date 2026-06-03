"""External data fetchers: prices (pykrx + yfinance) and FX rates.

For Korean stocks (yfinance symbol ending in .KS / .KQ), pykrx is tried first
because it tends to be more accurate and supports more KOSDAQ tickers. yfinance
is used as fallback and for non-Korean tickers.
"""
from __future__ import annotations
import pandas as pd
from datetime import datetime, timedelta
import yfinance as yf
from config import load_ticker_map, FX_TICKERS, DEFAULT_FX, now_kst


def _is_korean(symbol: str) -> bool:
    return symbol.endswith(".KS") or symbol.endswith(".KQ")


def _to_pykrx_code(symbol: str) -> str | None:
    if _is_korean(symbol):
        return symbol[:-3]
    return None


def _pykrx_current(code: str) -> float | None:
    try:
        from pykrx import stock
        end = now_kst()
        start = end - timedelta(days=14)
        df = stock.get_market_ohlcv(start.strftime("%Y%m%d"),
                                      end.strftime("%Y%m%d"), code)
        if df is None or df.empty:
            return None
        return float(df["종가"].iloc[-1])
    except Exception:
        return None


def _pykrx_history(code: str, start: datetime, end: datetime) -> pd.Series:
    try:
        from pykrx import stock
        df = stock.get_market_ohlcv(start.strftime("%Y%m%d"),
                                      end.strftime("%Y%m%d"), code)
        if df is None or df.empty:
            return pd.Series(dtype=float)
        s = df["종가"].copy()
        s.index = pd.to_datetime(s.index).normalize()
        return s
    except Exception:
        return pd.Series(dtype=float)


def _safe_yf_history(symbol: str, period: str = "5d") -> pd.DataFrame:
    try:
        return yf.Ticker(symbol).history(period=period, auto_adjust=False)
    except Exception:
        return pd.DataFrame()


def get_current_price(ticker_name: str) -> float | None:
    """Latest close in the ticker's native currency. pykrx for KR, else yfinance."""
    symbol = load_ticker_map().get(ticker_name)
    if not symbol:
        return None
    if _is_korean(symbol):
        code = _to_pykrx_code(symbol)
        if code:
            p = _pykrx_current(code)
            if p is not None:
                return p
    df = _safe_yf_history(symbol, period="5d")
    if df.empty:
        return None
    return float(df["Close"].dropna().iloc[-1])


def get_current_fx() -> dict[str, float]:
    rates = {"KRW": 1.0}
    for ccy, symbol in FX_TICKERS.items():
        df = _safe_yf_history(symbol, period="5d")
        if df.empty:
            rates[ccy] = DEFAULT_FX.get(ccy, 1.0)
        else:
            rates[ccy] = float(df["Close"].dropna().iloc[-1])
    return rates


def get_price_history(ticker_name: str, start: datetime, end: datetime | None = None) -> pd.Series:
    """Daily close prices in native currency between two dates."""
    symbol = load_ticker_map().get(ticker_name)
    if not symbol:
        return pd.Series(dtype=float)
    end = end or now_kst()
    if _is_korean(symbol):
        code = _to_pykrx_code(symbol)
        if code:
            s = _pykrx_history(code, start, end)
            if not s.empty:
                return s
    try:
        df = yf.Ticker(symbol).history(start=start.strftime("%Y-%m-%d"),
                                        end=(end + timedelta(days=1)).strftime("%Y-%m-%d"),
                                        auto_adjust=False)
        if df.empty:
            return pd.Series(dtype=float)
        s = df["Close"].copy()
        s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
        return s
    except Exception:
        return pd.Series(dtype=float)


def get_fx_history(currency: str, start: datetime, end: datetime | None = None) -> pd.Series:
    if currency == "KRW":
        idx = pd.date_range(start=start, end=(end or now_kst()), freq="D")
        return pd.Series(1.0, index=idx)
    symbol = FX_TICKERS.get(currency)
    if not symbol:
        return pd.Series(dtype=float)
    end = end or now_kst()
    try:
        df = yf.Ticker(symbol).history(start=start.strftime("%Y-%m-%d"),
                                        end=(end + timedelta(days=1)).strftime("%Y-%m-%d"),
                                        auto_adjust=False)
        if df.empty:
            return pd.Series(dtype=float)
        s = df["Close"].copy()
        s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
        return s
    except Exception:
        return pd.Series(dtype=float)


def get_prices_bulk(tickers: list[str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for t in tickers:
        p = get_current_price(t)
        if p is not None:
            out[t] = p
    return out
