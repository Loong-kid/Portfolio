"""Portfolio Dashboard — Streamlit app (snapshot-primary).

Source of truth: `snapshots` tab. Current state = latest snapshot × current prices.
Past NAV / 좌수 / 기준가 / 금융수익금 are derived from snapshots + flows + debt.
"""
from __future__ import annotations
import streamlit as st
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
from datetime import datetime

from config import (PORTFOLIO_NAME, GOOGLE_SHEET_ID,
                    load_category_map, save_category_map,
                    load_ticker_map, save_ticker_map,
                    now_kst, today_kst)
from portfolio import (
    load_snapshots, list_snapshot_dates, latest_snapshot_date,
    get_snapshot, get_latest_snapshot, save_snapshot, delete_snapshot,
    load_flows, append_flow, save_flows, FLOW_HEADERS,
    load_debt_history, upsert_debt, debt_at,
    load_nav_anchors,
    value_holdings, category_breakdown,
    compute_nav_history, compute_income_summary,
    load_portfolio_order, save_portfolio_order,
    load_stock_notes, save_stock_notes, STOCK_NOTES_HEADERS,
    CASH_TICKERS, ACCOUNT_TICKERS, SNAPSHOT_HEADERS,
)
import sheets_db
from data_fetcher import (get_current_price, get_current_fx, get_prices_bulk,
                            get_price_history, get_fx_history)
from auth import require_login, logout_button

st.set_page_config(page_title="포트폴리오 모니터", page_icon="📊", layout="wide")

# ============== Auth gate ==============
role = require_login()           # 'admin' or 'guest'
is_admin = (role == "admin")
is_guest = (role == "guest")


# ============== Setup ==============
_active_name = PORTFOLIO_NAME

if "schemas_synced" not in st.session_state:
    try:
        sheets_db.ensure_all_tabs()
        st.session_state["schemas_synced"] = True
    except Exception as _e:
        st.session_state["schemas_synced"] = True
        st.warning(f"스키마 동기화 실패: {_e}")


@st.cache_data(ttl=60, show_spinner="스냅샷 불러오는 중...")
def cached_load_snapshots() -> pd.DataFrame:
    return load_snapshots()


@st.cache_data(ttl=60, show_spinner="자금 흐름 불러오는 중...")
def cached_load_flows() -> pd.DataFrame:
    return load_flows()


@st.cache_data(ttl=60, show_spinner="부채 이력 불러오는 중...")
def cached_load_debt() -> pd.DataFrame:
    return load_debt_history()


@st.cache_data(ttl=60, show_spinner="NAV anchors 불러오는 중...")
def cached_load_nav_anchors() -> pd.DataFrame:
    return load_nav_anchors()


@st.cache_data(ttl=600, show_spinner="현재가 가져오는 중...")
def cached_current_prices(tickers_tuple: tuple[str, ...]
                          ) -> tuple[dict[str, float], datetime]:
    return get_prices_bulk(list(tickers_tuple)), now_kst()


@st.cache_data(ttl=600, show_spinner="환율 가져오는 중...")
def cached_fx() -> tuple[dict[str, float], datetime]:
    return get_current_fx(), now_kst()


@st.cache_data(ttl=3600, show_spinner="가격 이력 가져오는 중...")
def cached_price_history(tickers_tuple: tuple[str, ...],
                          start_iso: str, end_iso: str) -> dict[str, pd.Series]:
    start = datetime.fromisoformat(start_iso)
    end = datetime.fromisoformat(end_iso)
    return {t: get_price_history(t, start, end) for t in tickers_tuple}


@st.cache_data(ttl=3600, show_spinner="환율 이력 가져오는 중...")
def cached_fx_history(currencies_tuple: tuple[str, ...],
                       start_iso: str, end_iso: str) -> dict[str, pd.Series]:
    start = datetime.fromisoformat(start_iso)
    end = datetime.fromisoformat(end_iso)
    return {c: get_fx_history(c, start, end) for c in currencies_tuple}


def fmt_krw(v) -> str:
    if v is None or pd.isna(v):
        return "-"
    if abs(v) >= 1e8:
        return f"₩{v/1e8:.2f}억"
    if abs(v) >= 1e4:
        return f"₩{v/1e4:.0f}만"
    return f"₩{v:,.0f}"


def fmt_pct(v) -> str:
    if v is None or pd.isna(v):
        return "-"
    return f"{v*100:+.2f}%"


# ============== SIDEBAR ==============
with st.sidebar:
    badge = "👑 관리자" if is_admin else "👀 게스트"
    st.caption(f"활성: **{_active_name}**  ·  {badge}")
    logout_button()

    if is_admin:
        st.divider()
        if st.button("🔄 새로고침 (캐시 비우기)", use_container_width=True):
            sheets_db.invalidate_cache()
            st.cache_data.clear()
            st.rerun()
        st.divider()
        st.caption(
            "**구조** (snapshot-primary)\n\n"
            "• `snapshots` = 진실의 원천\n"
            "• `flows` = 외부 자금 유입/유출 (좌수)\n"
            "• `debt_history` = 부채 LOCF\n\n"
            "현재 상태 = 가장 최근 스냅샷 × 현재가"
        )


# ============== Data load ==============
snapshots_df = cached_load_snapshots()
flows_df = cached_load_flows()
debt_df = cached_load_debt()
nav_anchors_df = cached_load_nav_anchors()

latest_snap_dt = latest_snapshot_date()
holdings_raw = get_latest_snapshot() if not snapshots_df.empty else pd.DataFrame(
    columns=["통화", "수량", "평균단가"])

tradable_tickers = tuple(t for t in holdings_raw.index
                         if t not in CASH_TICKERS and t not in ACCOUNT_TICKERS)
prices, _prices_at = (cached_current_prices(tradable_tickers)
                       if tradable_tickers else ({}, now_kst()))
fx_rates, _fx_at = cached_fx()
_snap_prices: dict[str, float] = {}
if not holdings_raw.empty and "현재가" in holdings_raw.columns:
    _snap_prices = {
        t: float(v) for t, v in holdings_raw["현재가"].items()
        if pd.notna(v) and float(v) > 0
    }
valued = value_holdings(holdings_raw, prices, fx_rates,
                         snapshot_prices=_snap_prices)
_fallback_snapshot = (valued["가격출처"] == "snapshot").sum() if "가격출처" in valued.columns else 0
_fallback_missing = (valued["가격출처"] == "missing").sum() if "가격출처" in valued.columns else 0

total_value = float(valued["평가액"].sum()) if not valued.empty else 0.0
total_unrealized = float(valued["평가손익"].sum()) if not valued.empty else 0.0
total_cost = float(valued["원가"].sum()) if not valued.empty else 0.0

if is_admin:
    with st.sidebar:
        st.divider()
        st.caption(f"📈 현재가: **{_prices_at.strftime('%H:%M:%S')} KST** · 10분 캐시")
        st.caption(f"💱 환율: **{_fx_at.strftime('%H:%M:%S')} KST** · 10분 캐시")
        if _fallback_snapshot or _fallback_missing:
            _fb_tickers = valued[valued["가격출처"].isin(("snapshot", "missing"))].index.tolist()
            _msg_lines = ["⚠️ 일부 종목 현재가 fetch 실패:"]
            for _t in _fb_tickers:
                _src = valued.loc[_t, "가격출처"]
                _tag = "스냅샷 가격 사용" if _src == "snapshot" else "가격 없음"
                _msg_lines.append(f"• **{_t}** — {_tag}")
            st.warning("\n\n".join(_msg_lines))


# ============== HEADER ==============
st.title(f"📊 {_active_name}의 포트폴리오")

if snapshots_df.empty:
    st.warning(
        "스냅샷이 없습니다. **📸 스냅샷** 탭에서 첫 스냅샷을 추가하세요. "
        "(빈 시트라면 `migrate_to_snapshot.py` 실행으로 시드 가능)"
    )
else:
    c1, c2, c3 = st.columns(3)
    if is_guest:
        c1.metric("총 평가액", "•••")
        c2.metric("평가 손익", "•••")
    else:
        c1.metric("총 평가액", fmt_krw(total_value))
        c2.metric("평가 손익", fmt_krw(total_unrealized),
                   fmt_pct(total_unrealized / total_cost) if total_cost else None)
    c3.metric("최근 스냅샷",
              pd.Timestamp(latest_snap_dt).strftime("%Y-%m-%d") if latest_snap_dt else "—")

if is_admin:
    st.caption(f"환율: USD {fx_rates.get('USD', 0):.1f} / "
               f"EUR {fx_rates.get('EUR', 0):.1f} / "
               f"JPY {fx_rates.get('JPY', 0):.2f}")
st.divider()


# ============== TABS ==============
# Guest: 1탭만 (현재 포트폴리오) — tab1 처리 후 st.stop()으로 나머지 skip
if is_admin:
    tab1, tab_snap, tab_flows, tab_nav, tab_notes, tab_settings = st.tabs([
        "💼 현재 포트폴리오", "📸 스냅샷", "💸 외부 자금 흐름",
        "📈 자산 추이", "🎯 종목 메모", "⚙️ 설정",
    ])
else:
    (tab1,) = st.tabs(["💼 현재 포트폴리오"])
    # guest는 st.stop()으로 종료되지만 NameError 방지용 dummy placeholder
    tab_snap = tab_flows = tab_nav = tab_notes = tab_settings = st.empty()


# -------- Tab 1: Current Portfolio --------
with tab1:
    if valued.empty:
        st.info("보유 종목 없음.")
    else:
        left, right = st.columns([3, 2])
        with left:
            hdr_c1, hdr_c2 = st.columns([3, 2])
            with hdr_c1:
                st.subheader("보유 종목")
            with hdr_c2:
                if is_guest:
                    blur_on = True
                    st.caption("🔒 민감 정보 블러 (게스트 모드, 잠금)")
                else:
                    blur_on = st.checkbox("🔒 민감 정보 블러",
                                           key="blur_sensitive", value=False)

            order_map = load_portfolio_order()
            display = valued.reset_index().copy()
            display = display[["종목", "카테고리", "통화", "환율", "수량",
                                "평균단가", "현재가", "평가액", "평가손익", "수익률"]]
            display["수익률"] = display["수익률"] * 100
            display["_ord"] = display["종목"].map(lambda t: order_map.get(t, 99))
            display = (display.sort_values(["_ord", "평가액"],
                                              ascending=[True, False])
                                .drop(columns=["_ord"]).reset_index(drop=True))

            _cash_acct = set(CASH_TICKERS) | set(ACCOUNT_TICKERS)
            display.loc[display["종목"].isin(_cash_acct),
                          ["평균단가", "수익률", "평가손익"]] = float("nan")
            display.loc[display["통화"] == "KRW", "환율"] = float("nan")
            display.loc[display["종목"].isin(set(ACCOUNT_TICKERS) | {"KRW현금"}),
                          "수량"] = float("nan")
            for _c in ["평균단가", "수익률", "평가손익", "환율", "수량"]:
                display[_c] = pd.to_numeric(display[_c], errors="coerce")

            _sensitive_cfg = (
                {"수량": st.column_config.TextColumn("수량"),
                 "평가액": st.column_config.TextColumn("평가액"),
                 "평가손익": st.column_config.TextColumn("평가손익")}
                if blur_on else
                {"수량": st.column_config.NumberColumn(format="%.4g"),
                 "평가액": st.column_config.NumberColumn(format="₩%,d"),
                 "평가손익": st.column_config.NumberColumn(format="₩%,d")}
            )
            common_col_config = {
                "환율": st.column_config.NumberColumn(format="%.2f"),
                "평균단가": st.column_config.NumberColumn(format="%.4g"),
                "현재가": st.column_config.NumberColumn(format="%.4g"),
                "수익률": st.column_config.NumberColumn(format="%.2f%%"),
                **_sensitive_cfg,
            }
            display_show = display.copy()
            if blur_on:
                for _bcol in ["수량", "평가액", "평가손익"]:
                    display_show[_bcol] = "•••"
            st.dataframe(display_show, use_container_width=True,
                          hide_index=True, column_config=common_col_config)

            if is_admin: _show_order_editor = st.expander("↕ 순서 편집")
            else: _show_order_editor = None
            if _show_order_editor is not None:
              with _show_order_editor:
                st.caption("💡 **순서** 칸 수정 (작은 수가 위로).")
                order_df = display.copy()
                order_df.insert(0, "순서",
                                 order_df["종목"].map(lambda t: order_map.get(t, 99)))
                if blur_on:
                    for _bcol in ["수량", "평가액", "평가손익"]:
                        order_df[_bcol] = "•••"
                edited = st.data_editor(
                    order_df, use_container_width=True, hide_index=True,
                    key="port_order_editor",
                    column_config={
                        "순서": st.column_config.NumberColumn(
                            "↕", help="작은 수가 위로", min_value=0,
                            max_value=999, step=1, width="small"),
                        **common_col_config,
                    },
                    disabled=["종목", "카테고리", "통화", "환율", "수량",
                                "평균단가", "현재가", "평가액", "평가손익", "수익률"],
                )
                if st.button("💾 순서 저장", type="primary", key="save_order"):
                    new_order = {}
                    for _, row in edited.iterrows():
                        t = str(row["종목"]).strip()
                        try:
                            r = int(float(row["순서"]))
                        except (TypeError, ValueError):
                            r = 99
                        if t:
                            new_order[t] = r
                    save_portfolio_order(new_order)
                    st.success(f"✅ {len(new_order)}개 종목 순서 저장됨")
                    st.cache_data.clear()
                    st.rerun()

        with right:
            st.subheader("카테고리 비중")
            cat = category_breakdown(valued)
            if not cat.empty:
                fig = px.pie(cat, values="평가액", names="카테고리", hole=0.5)
                fig.update_traces(textposition="inside",
                                   textinfo="percent+label")
                if blur_on:
                    # hover에서 평가액 숨김 — 카테고리 + % 만
                    fig.update_traces(
                        hovertemplate="<b>%{label}</b><br>%{percent}<extra></extra>")
                fig.update_layout(height=400, showlegend=False,
                                   margin=dict(t=10, b=10, l=10, r=10))
                st.plotly_chart(fig, use_container_width=True)

        st.subheader("종목별 비중")
        _bar_data = valued.reset_index().copy()
        _cash_mask = _bar_data["종목"].isin(CASH_TICKERS)
        if _cash_mask.any():
            _cash_sum = _bar_data.loc[_cash_mask, "평가액"].sum()
            _bar_data = pd.concat([
                _bar_data[~_cash_mask],
                pd.DataFrame([{"종목": "현금", "카테고리": "현금",
                                 "평가액": _cash_sum}]),
            ], ignore_index=True)

        if blur_on:
            # 평가액 노출 없이 비중(%)으로만 표시 (막대 길이도 % 기준)
            _total = _bar_data["평가액"].sum()
            if _total > 0:
                _bar_data = _bar_data.copy()
                _bar_data["비중"] = _bar_data["평가액"] / _total * 100
                top = _bar_data.sort_values("비중", ascending=True).tail(15)
                fig2 = px.bar(top, x="비중", y="종목", orientation="h",
                               color="카테고리", text="비중")
                fig2.update_traces(
                    texttemplate="%{x:.1f}%",
                    textposition="outside",
                    hovertemplate="<b>%{y}</b><br>%{x:.1f}%<extra></extra>")
                fig2.update_xaxes(title_text="비중 (%)")
            else:
                fig2 = go.Figure()
        else:
            top = _bar_data.sort_values("평가액", ascending=True).tail(15)
            fig2 = px.bar(top, x="평가액", y="종목", orientation="h",
                           color="카테고리", text="평가액")
            fig2.update_traces(texttemplate="₩%{x:,.0f}",
                                textposition="outside")
        fig2.update_layout(height=500, showlegend=False,
                            margin=dict(t=10, b=10, l=10, r=80))
        st.plotly_chart(fig2, use_container_width=True)

# Guest: tab1만 보여주고 끝
if is_guest:
    st.stop()


# -------- Tab 2: Snapshots (edit/add/delete) --------
with tab_snap:
    st.subheader("📸 스냅샷 (진실의 원천)")
    st.caption(
        "각 행 = (날짜, 종목, 통화, 수량, 평균단가, 현재가, 환율, 평가액). "
        "**평가액은 그 시점 가치가 그대로 박힘 — 자산 추이 차트가 이 값을 사용**. "
        "오늘 스냅샷이면 자동으로 현재가/환율 채워주고, 과거 시점이면 직접 입력하거나 "
        "Google Sheet에서 raw 편집."
    )

    with st.expander("🗒️ Google Sheet `snapshots` 탭 양식 (raw 편집용)"):
        st.markdown(
            "| 컬럼 | 형식 | 비고 |\n"
            "|---|---|---|\n"
            "| `날짜` | `YYYY-MM-DD` | 같은 날짜의 모든 행이 한 스냅샷 |\n"
            "| `종목` | 문자열 | 현금은 `KRW현금/USD현금/EUR현금/JPY현금`, 연금은 `개인연금/퇴직연금` |\n"
            "| `통화` | `KRW`/`USD`/`EUR`/`JPY` | |\n"
            "| `수량` | 숫자 | 0이면 앱에서 자동 제거 |\n"
            "| `평균단가` | 숫자 (현지 통화) | 현금/연금은 `1` |\n"
            "| `현재가` | 숫자 (현지 통화) | 그 시점 가격 |\n"
            "| `환율` | 숫자 (1통화→KRW) | KRW면 `1`, 외화면 그 시점 환율 |\n"
            "| `평가액` | 숫자 (원) | = 수량 × 현재가 × 환율 |\n"
            "\n"
            "직접 행 추가 시 같은 날짜의 모든 종목을 한 묶음으로 (연속 행). 정렬은 자동."
        )

    snap_list = list_snapshot_dates()

    def _enrich_with_current_prices(seed: pd.DataFrame) -> pd.DataFrame:
        """For today's snapshot: auto-fill 현재가/환율/평가액 from live prices."""
        seed = seed.copy()
        for col in ("현재가", "환율", "평가액"):
            if col not in seed.columns:
                seed[col] = float("nan")
        for i, row in seed.iterrows():
            t = str(row["종목"]).strip()
            if not t:
                continue
            ccy = (row["통화"] or "KRW").strip() or "KRW"
            fx_rate = 1.0 if ccy == "KRW" else fx_rates.get(ccy, 0.0)
            qty = pd.to_numeric(row.get("수량"), errors="coerce") or 0.0
            if t in CASH_TICKERS or t in ACCOUNT_TICKERS:
                cur = 1.0
            else:
                cur = float(prices.get(t) or 0.0)
            if pd.isna(row.get("현재가")) or row.get("현재가") == 0:
                seed.at[i, "현재가"] = cur if cur > 0 else float("nan")
            if pd.isna(row.get("환율")) or row.get("환율") == 0:
                seed.at[i, "환율"] = fx_rate
            cur_v = seed.at[i, "현재가"]
            fx_v = seed.at[i, "환율"]
            if pd.notna(cur_v) and pd.notna(fx_v):
                seed.at[i, "평가액"] = qty * cur_v * fx_v
        return seed

    def _render_editor(seed_df: pd.DataFrame, key: str) -> pd.DataFrame:
        return st.data_editor(
            seed_df, num_rows="dynamic", use_container_width=True,
            hide_index=True, key=key,
            column_config={
                "종목": st.column_config.TextColumn(width="medium"),
                "통화": st.column_config.SelectboxColumn(
                    options=["KRW", "USD", "EUR", "JPY"]),
                "수량": st.column_config.NumberColumn(format="%.6g"),
                "평균단가": st.column_config.NumberColumn(format="%.6g",
                    help="현금/연금은 1"),
                "현재가": st.column_config.NumberColumn(format="%.6g",
                    help="그 시점 현지통화 가격. 현금/연금은 1"),
                "환율": st.column_config.NumberColumn(format="%.4g",
                    help="1통화→KRW. KRW면 1"),
                "평가액": st.column_config.NumberColumn(format="%.0f",
                    help="원화 평가액. 비어두면 수량×현재가×환율로 자동계산"),
            },
        )

    if snap_list.empty:
        st.warning("스냅샷 없음. 아래 표에 입력하고 저장해줘.")
        target_date = st.date_input("✨ 첫 스냅샷 날짜",
                                       value=today_kst(),
                                       key="snap_new_date_empty")
        seed_df = pd.DataFrame([
            {"종목": "KRW현금", "통화": "KRW", "수량": 1000000.0, "평균단가": 1.0,
             "현재가": 1.0, "환율": 1.0, "평가액": 1000000.0},
            {"종목": "",       "통화": "KRW", "수량": 0.0,        "평균단가": 0.0,
             "현재가": float("nan"), "환율": float("nan"), "평가액": float("nan")},
        ])
        edited = _render_editor(seed_df, key="snap_seed_editor")
        if st.button("✨ 첫 스냅샷 저장", type="primary",
                       key="save_first_snap"):
            preview = edited.copy()
            preview["종목"] = preview["종목"].astype(str).str.strip()
            preview["수량"] = pd.to_numeric(preview["수량"], errors="coerce").fillna(0.0)
            preview = preview[(preview["종목"] != "") & (preview["수량"].abs() > 1e-9)]
            if preview.empty:
                st.error("저장할 행 없음 (종목명 + 0이 아닌 수량 1개 이상 필요).")
            else:
                try:
                    res = save_snapshot(pd.Timestamp(target_date), edited)
                    st.cache_data.clear()
                    st.success(f"✅ {res['date']} 스냅샷 저장: {res['rows']}행")
                    st.rerun()
                except Exception as e:
                    st.error(f"❌ 저장 실패: {type(e).__name__}: {e}")
                    st.exception(e)
    else:
        sd_c1, sd_c2 = st.columns([2, 3])
        with sd_c1:
            mode = st.radio("모드", ["기존 스냅샷 편집", "새 스냅샷 추가"],
                             horizontal=True, key="snap_mode")
        if mode == "기존 스냅샷 편집":
            with sd_c2:
                edit_date = st.selectbox(
                    "편집할 날짜",
                    options=snap_list["날짜"].dt.strftime("%Y-%m-%d").tolist(),
                    key="snap_edit_date",
                )
            target_dt = pd.Timestamp(edit_date)
        else:
            with sd_c2:
                new_date = st.date_input(
                    "새 스냅샷 날짜 (과거 시점도 가능)",
                    value=today_kst(),
                    key="snap_new_date")
            target_dt = pd.Timestamp(new_date)

        is_today = target_dt.normalize() == pd.Timestamp(now_kst()).normalize()

        # Pre-fill
        existing = get_snapshot(target_dt)
        was_carry_over = False
        if existing.empty and mode == "새 스냅샷 추가":
            existing = get_latest_snapshot()
            was_carry_over = True
            if not existing.empty:
                st.caption(
                    f"💡 가장 최근 스냅샷({pd.Timestamp(latest_snap_dt).date()})에서 "
                    "수량/평균단가/통화를 미리 채움. "
                    + ("오늘이라 **현재가/환율/평가액은 새로 fetch한 값으로 자동 갱신**됨."
                       if is_today
                       else "**과거 시점이라 현재가/환율/평가액은 직접 입력해야 함** (시트 raw 편집 권장)")
                )

        all_cols = ["종목", "통화", "수량", "평균단가", "현재가", "환율", "평가액"]
        if existing.empty:
            seed_df = pd.DataFrame([{
                "종목": "KRW현금", "통화": "KRW", "수량": 0.0, "평균단가": 1.0,
                "현재가": 1.0, "환율": 1.0, "평가액": 0.0,
            }])
        else:
            seed_df = existing.reset_index()
            for c in all_cols:
                if c not in seed_df.columns:
                    seed_df[c] = float("nan")
            seed_df = seed_df[all_cols]

        # editor key versioning — 🔄 누를 때마다 v++ → 새 widget으로 인식
        # (streamlit data_editor가 같은 key면 internal state를 캐시해서 seed_df 무시함)
        ver_key = f"_snap_ver_{target_dt.strftime('%Y%m%d')}_{mode}"
        version = st.session_state.get(ver_key, 0)
        editor_key = f"snap_editor_{target_dt.strftime('%Y%m%d')}_{mode}_v{version}"
        force_refresh = st.session_state.pop("_snap_force_refresh", False)

        # 새 스냅샷 + 오늘이면 carry-over 가격 비움 (auto fetch)
        # 또는 사용자가 🔄 버튼 누른 경우도 비움
        if (was_carry_over and is_today) or force_refresh:
            seed_df["현재가"] = float("nan")
            seed_df["환율"] = float("nan")
            seed_df["평가액"] = float("nan")

        # 오늘 스냅샷이면 비어있는 현재가/환율/평가액을 live 시세로 채움
        if is_today:
            seed_df = _enrich_with_current_prices(seed_df)

        # 🔄 현재 시세로 갱신 + 즉시 저장 (data_editor 거치지 않음 → state 캐시 무관)
        ref_c1, ref_c2 = st.columns([1, 3])
        with ref_c1:
            if st.button("🔄 현재 시세로 갱신 + 저장",
                          use_container_width=True,
                          type="secondary",
                          key=f"refresh_btn_{mode}"):
                # seed_df의 수량/평균단가/통화는 그대로, 가격만 fresh fetch
                fresh = seed_df.copy()
                fresh["현재가"] = float("nan")
                fresh["환율"] = float("nan")
                fresh["평가액"] = float("nan")
                fresh = _enrich_with_current_prices(fresh)
                try:
                    res = save_snapshot(target_dt, fresh)
                    st.cache_data.clear()
                    st.success(
                        f"✅ {res['date']} 새 시세로 저장됨: {res['rows']}행. "
                        f"총 평가액 ₩{fresh['평가액'].sum():,.0f}"
                    )
                    # widget 새로 그리기 위해 version 증가
                    st.session_state[ver_key] = version + 1
                    st.rerun()
                except Exception as e:
                    st.error(f"❌ 저장 실패: {type(e).__name__}: {e}")
                    st.exception(e)
        with ref_c2:
            if mode == "기존 스냅샷 편집":
                st.caption("⚠️ 저장된 historical 가격을 **오늘 시세로 덮어씌우고 즉시 저장**. "
                            "data_editor cell 편집은 무시됨. 보통 오늘 시점에 사용.")
            else:
                st.caption("💡 carry-over한 옛 가격을 **현재 시세로 갱신 + 즉시 저장**. "
                            "cell 편집 없이 시세만 빨리 박을 때.")

        st.markdown(f"##### 📋 {target_dt.strftime('%Y-%m-%d')} 스냅샷")
        if is_today:
            st.caption("✅ 오늘 시점 — 현재가/환율 자동 채움. 평가액 = 수량×현재가×환율로 자동계산. 그대로 저장 OK.")
        else:
            st.caption("⏳ 과거 시점 — 그 날의 현재가/환율/평가액을 직접 입력해줘 (또는 시트에서 raw 편집).")

        edited = _render_editor(seed_df, key=f"snap_editor_{target_dt.strftime('%Y%m%d')}_{mode}")

        # Total 평가액 preview
        try:
            total_preview = pd.to_numeric(edited["평가액"], errors="coerce").sum()
            st.caption(f"📊 입력된 평가액 합계: **{fmt_krw(total_preview)}**")
        except Exception:
            pass

        sa_c1, sa_c2, sa_c3 = st.columns([1, 1, 2])
        with sa_c1:
            if st.button("💾 저장", type="primary",
                           use_container_width=True, key="save_snap"):
                try:
                    clean = edited[all_cols].copy()
                    # If 평가액 missing but 현재가/환율/수량 present → compute
                    cur = pd.to_numeric(clean["현재가"], errors="coerce")
                    fxc = pd.to_numeric(clean["환율"], errors="coerce")
                    qty = pd.to_numeric(clean["수량"], errors="coerce")
                    val = pd.to_numeric(clean["평가액"], errors="coerce")
                    mask_fill = val.isna() & cur.notna() & fxc.notna() & qty.notna()
                    clean.loc[mask_fill, "평가액"] = qty[mask_fill] * cur[mask_fill] * fxc[mask_fill]
                    res = save_snapshot(target_dt, clean)
                    st.cache_data.clear()
                    st.success(f"✅ {res['date']} 저장: {res['rows']}행")
                    st.rerun()
                except Exception as e:
                    st.error(f"❌ 저장 실패: {type(e).__name__}: {e}")
                    st.exception(e)
        with sa_c2:
            if mode == "기존 스냅샷 편집":
                if st.button("🗑️ 이 스냅샷 삭제", key="del_snap"):
                    res = delete_snapshot(target_dt)
                    st.cache_data.clear()
                    if res.get("removed", 0) > 0:
                        st.success(f"✅ {res['date']} {res['removed']}행 삭제")
                    else:
                        st.info(f"ℹ️ {res.get('status')}")
                    st.rerun()
        with sa_c3:
            st.caption("`수량=0` 행은 자동 제거. 평가액 비우면 수량×현재가×환율로 자동계산.")

        st.divider()
        st.markdown("##### 📜 스냅샷 목록")
        snap_list_show = snap_list.copy()
        snap_list_show["날짜"] = snap_list_show["날짜"].dt.strftime("%Y-%m-%d")
        st.dataframe(snap_list_show, use_container_width=True,
                      hide_index=True,
                      column_config={
                          "날짜": st.column_config.TextColumn(width="medium"),
                          "행수": st.column_config.NumberColumn(format="%d"),
                      })


# -------- Tab 3: External Cash Flows --------
with tab_flows:
    st.subheader("💸 외부 자금 흐름")
    st.caption(
        "외부에서 들어오거나 빠진 돈만 기록. (근로소득·외부 송금·대출 입금/상환). "
        "스냅샷 사이의 현금 변화 중 **외부 발생분만 여기에**. 이자/배당/매매 차익은 "
        "스냅샷에서 자동으로 잡힘. **좌수/기준가 계산의 유일한 외부 자금 입력.**"
    )

    with st.form("flow_form", clear_on_submit=True):
        st.markdown("##### ➕ 새 흐름 추가")
        ff_c1, ff_c2, ff_c3 = st.columns(3)
        with ff_c1:
            f_date = st.date_input("날짜", value=today_kst(),
                                     key="flow_date")
            f_ccy = st.selectbox("통화", ["KRW", "USD", "EUR", "JPY"],
                                   key="flow_ccy")
        with ff_c2:
            f_amount_str = st.text_input(
                "금액 (signed: + 유입, − 유출)",
                value="", placeholder="예: 1,000,000 또는 -500,000",
                key="flow_amt",
            )
        with ff_c3:
            f_memo = st.text_input("메모",
                                     placeholder="예: 4월 급여 / 대출 입금",
                                     key="flow_memo")
        f_submit = st.form_submit_button("➕ 추가", type="primary",
                                            use_container_width=True)
        if f_submit:
            try:
                f_amount = float(f_amount_str.replace(",", "").strip())
            except ValueError:
                f_amount = 0.0
            if f_amount == 0:
                st.error("금액이 0 또는 비어있음 (음수 가능, 쉼표 OK)")
            else:
                append_flow(pd.Timestamp(f_date), f_ccy, f_amount, f_memo)
                st.cache_data.clear()
                sign = "+" if f_amount > 0 else "−"
                st.success(f"✅ {f_date} {sign}{abs(f_amount):,.0f} {f_ccy} 추가")
                st.rerun()

    st.divider()
    st.markdown("##### 📋 자금 흐름 목록 (편집 가능)")
    if flows_df.empty:
        st.info("자금 흐름 기록 없음. 위 폼에서 추가하세요.")
    else:
        view = flows_df.copy()
        view["날짜"] = pd.to_datetime(view["날짜"]).dt.strftime("%Y-%m-%d")
        edited_flows = st.data_editor(
            view, num_rows="dynamic", use_container_width=True,
            hide_index=True, key="flows_editor",
            column_config={
                "날짜": st.column_config.TextColumn(width="small"),
                "통화": st.column_config.SelectboxColumn(
                    options=["KRW", "USD", "EUR", "JPY"]),
                "금액": st.column_config.NumberColumn(format="%.2f",
                    help="+ 유입, − 유출"),
                "메모": st.column_config.TextColumn(width="large"),
            },
        )
        fa_c1, fa_c2 = st.columns([1, 5])
        with fa_c1:
            if st.button("💾 변경사항 저장", type="primary",
                           use_container_width=True, key="save_flows"):
                clean = edited_flows.copy()
                clean["날짜"] = clean["날짜"].astype(str).str.strip()
                clean = clean[clean["날짜"] != ""]
                clean["금액"] = pd.to_numeric(clean["금액"], errors="coerce")
                clean = clean.dropna(subset=["금액"])
                save_flows(clean)
                st.cache_data.clear()
                st.success(f"✅ {len(clean)}건 저장")
                st.rerun()
        with fa_c2:
            st.caption("행 삭제 / 추가 / 수정 후 💾 클릭. 음수 금액은 출금.")


# -------- Tab 4: NAV / 좌수 / 기준가 / 금융수익금 --------
with tab_nav:
    st.subheader("📈 자산 추이")
    st.caption(
        "스냅샷 + 자금 흐름 + 부채로부터 derive. "
        "스냅샷 없는 날은 직전 스냅샷의 수량을 carry forward해서 그 날 종가로 계산. "
        "**좌수/기준가는 외부 자금 흐름이 정확해야 의미 있음.**"
    )

    if snapshots_df.empty and nav_anchors_df.empty:
        st.info("스냅샷·NAV anchor 둘 다 없어서 자산 추이 불가. 📸 스냅샷 탭에서 추가하거나 `migrate_nav_anchors.py`를 실행.")
    else:
        # Date range — earliest = min(first snapshot, first anchor)
        candidates = []
        if not snapshots_df.empty:
            candidates.append(snapshots_df["날짜"].min().date())
        if not nav_anchors_df.empty:
            candidates.append(nav_anchors_df["날짜"].min().date())
        d_first = min(candidates)
        d_today = today_kst()
        rc_c1, rc_c2 = st.columns([3, 1])
        with rc_c1:
            date_range = st.date_input(
                "기간", value=(d_first, d_today),
                min_value=d_first, max_value=d_today, key="nav_range")
        with rc_c2:
            show_total = st.checkbox("총자산 함께 표시", value=True,
                                       key="nav_show_total")

        if isinstance(date_range, tuple) and len(date_range) == 2:
            sd, ed = date_range
        else:
            sd, ed = d_first, d_today

        with st.spinner("자산 추이 계산 중 (가격/환율 이력 fetch)..."):
            try:
                stock_tickers = tuple(sorted(
                    t for t in snapshots_df["종목"].unique()
                    if t not in CASH_TICKERS and t not in ACCOUNT_TICKERS
                    and "→" not in str(t)
                ))
                price_hist = (cached_price_history(stock_tickers,
                                                     sd.isoformat(),
                                                     ed.isoformat())
                                if stock_tickers else {})
                fx_hist = cached_fx_history(("USD", "EUR", "JPY"),
                                              sd.isoformat(), ed.isoformat())
                nav_hist = compute_nav_history(
                    snapshots_df, flows_df, debt_df,
                    price_hist, fx_hist,
                    nav_anchors_df=nav_anchors_df,
                    start=pd.Timestamp(sd), end=pd.Timestamp(ed),
                    business_days_only=True,
                )
            except Exception as e:
                st.error(f"자산 추이 계산 실패: {e}")
                nav_hist = pd.DataFrame()

        if nav_hist.empty:
            st.warning("계산된 행이 없음. 스냅샷 날짜 / 기간을 확인하세요.")
        else:
            # NAV chart
            fig = go.Figure()
            fig.add_trace(go.Scatter(
                x=nav_hist["날짜"], y=nav_hist["순자산"],
                mode="lines", name="순자산",
                line=dict(color="#2E86AB", width=2.5),
                fill="tozeroy", fillcolor="rgba(46,134,171,0.08)"))
            if show_total:
                fig.add_trace(go.Scatter(
                    x=nav_hist["날짜"], y=nav_hist["총자산"],
                    mode="lines", name="총자산",
                    line=dict(color="#A23B72", width=2, dash="dash")))
            # Overlay original anchor points (for visual reference)
            if not nav_anchors_df.empty:
                anc_in_range = nav_anchors_df[
                    (nav_anchors_df["날짜"].dt.date >= sd)
                    & (nav_anchors_df["날짜"].dt.date <= ed)
                ]
                if not anc_in_range.empty:
                    fig.add_trace(go.Scatter(
                        x=anc_in_range["날짜"], y=anc_in_range["순자산"],
                        mode="markers", name="anchor (수동입력)",
                        marker=dict(color="#2E86AB", size=8,
                                      symbol="diamond", line=dict(color="white", width=1))))
            fig.update_layout(height=420, yaxis_title="원", xaxis_title="",
                              hovermode="x unified",
                              legend=dict(orientation="h", yanchor="bottom",
                                            y=1.02, xanchor="right", x=1),
                              margin=dict(t=30, b=10, l=10, r=10))
            fig.update_yaxes(tickformat=",.0f")
            st.plotly_chart(fig, use_container_width=True)

            # Summary
            first = nav_hist.iloc[0]
            last = nav_hist.iloc[-1]
            m_c1, m_c2, m_c3, m_c4 = st.columns(4)
            m_c1.metric(f"시작 ({pd.Timestamp(first['날짜']).strftime('%Y-%m-%d')})",
                          fmt_krw(first["순자산"]))
            m_c2.metric(f"현재 ({pd.Timestamp(last['날짜']).strftime('%Y-%m-%d')})",
                          fmt_krw(last["순자산"]))
            delta = last["순자산"] - first["순자산"]
            pct = (last["순자산"] / first["순자산"] - 1) if first["순자산"] else 0
            m_c3.metric("순자산 증감", fmt_krw(delta), fmt_pct(pct))
            m_c4.metric("스냅샷 수", f"{len(list_snapshot_dates())}")

            # 기준가 (TWR)
            unit_view = nav_hist[nav_hist["기준가_총자산"] > 0].copy()
            if len(unit_view) >= 2:
                st.markdown("##### 📈 기준가 (외부 자금 흐름 정규화 수익률)")
                st.caption(
                    "기준가 = 펀드 NAV 개념. 외부 자금 유입/유출에 영향받지 않는 순수 운용 성과. "
                    "**총자산 기준** = 부채 포함 / **순자산 기준** = 부채 제외. "
                    "옛 anchor(2024-12-24)에서 1000으로 시드된 raw 기준가 그대로 표시."
                )

                fig_u = go.Figure()
                fig_u.add_trace(go.Scatter(
                    x=unit_view["날짜"], y=unit_view["기준가_총자산"],
                    mode="lines", name="총자산 기준가",
                    line=dict(color="#F18F01", width=2.5)))
                has_net = (unit_view["기준가_순자산"] > 0).any()
                if has_net:
                    fig_u.add_trace(go.Scatter(
                        x=unit_view["날짜"], y=unit_view["기준가_순자산"],
                        mode="lines", name="순자산 기준가",
                        line=dict(color="#2E86AB", width=2.5, dash="dot")))
                fig_u.add_hline(y=1000, line_dash="dot", line_color="gray",
                                  annotation_text="seed = 1000")
                fig_u.update_layout(height=320, yaxis_title="기준가",
                                     xaxis_title="", hovermode="x unified",
                                     legend=dict(orientation="h",
                                                  yanchor="bottom", y=1.02,
                                                  xanchor="right", x=1),
                                     margin=dict(t=30, b=10, l=10, r=10))
                st.plotly_chart(fig_u, use_container_width=True)

                ufirst = unit_view.iloc[0]; ulast = unit_view.iloc[-1]
                u_delta_t = (ulast["기준가_총자산"] / ufirst["기준가_총자산"] - 1)
                uc1, uc2, uc3, uc4 = st.columns(4)
                uc1.metric("총 기준가 (현재)", f"{ulast['기준가_총자산']:,.2f}",
                            fmt_pct(u_delta_t))
                if has_net and ufirst["기준가_순자산"] > 0:
                    u_delta_n = (ulast["기준가_순자산"] / ufirst["기준가_순자산"] - 1)
                    uc2.metric("순 기준가 (현재)", f"{ulast['기준가_순자산']:,.2f}",
                                fmt_pct(u_delta_n))
                else:
                    uc2.metric("순 기준가 (현재)", "-")
                uc3.metric("좌수 총", f"{ulast['좌수_총']:,.2f}")
                uc4.metric("좌수 순", f"{ulast['좌수_순']:,.2f}")

                # ──── YTD 기준가 수익률 ────
                this_year = now_kst().year
                year_start = pd.Timestamp(this_year, 1, 1)
                unit_pre = unit_view[unit_view["날짜"] < year_start]
                if not unit_pre.empty:
                    ya = unit_pre.iloc[-1]
                    ya_date_str = pd.Timestamp(ya["날짜"]).strftime("%Y-%m-%d")
                    yc1, yc2, yc3, yc4 = st.columns(4)
                    if ya["기준가_총자산"] > 0:
                        ytd_t = ulast["기준가_총자산"] / ya["기준가_총자산"] - 1
                        yc1.metric(
                            f"{this_year} YTD 총 기준가",
                            fmt_pct(ytd_t),
                            help=f"{ya_date_str}: {ya['기준가_총자산']:,.2f} → "
                                 f"현재: {ulast['기준가_총자산']:,.2f}"
                        )
                    if has_net and ya["기준가_순자산"] > 0:
                        ytd_n = ulast["기준가_순자산"] / ya["기준가_순자산"] - 1
                        yc2.metric(
                            f"{this_year} YTD 순 기준가",
                            fmt_pct(ytd_n),
                            help=f"{ya_date_str}: {ya['기준가_순자산']:,.2f} → "
                                 f"현재: {ulast['기준가_순자산']:,.2f}"
                        )

                # 금융수익금
                try:
                    inc = compute_income_summary(nav_hist, flows_df)
                    if inc and "cum_income" in inc:
                        st.markdown("##### 💰 금융수익금 (순자산 기준)")
                        st.caption(
                            f"**baseline 순자산**: {inc['start_date']} "
                            f"({fmt_krw(inc['start_nav_net'])}, "
                            f"총자산 {fmt_krw(inc['start_nav_total'])} − 부채 "
                            f"{fmt_krw(inc['start_nav_total'] - inc['start_nav_net'])}). "
                            f"누적 외부유입: {fmt_krw(inc['cum_inflow'])}. "
                            f"부채 현재: {fmt_krw(inc['debt_now'])}. "
                            f"순자산 현재: {fmt_krw(inc['current_nav_net'])}."
                        )
                        inc_c1, inc_c2, inc_c3 = st.columns(3)
                        pct = (inc["cum_income"] / inc["start_nav_net"]
                                if inc["start_nav_net"] else None)
                        inc_c1.metric("누적 금융수익금",
                                        fmt_krw(inc["cum_income"]),
                                        fmt_pct(pct) if pct is not None else None)
                        if inc.get("ytd_income") is not None:
                            ytd_pct = (inc["ytd_income"] / inc["year_anchor_nav_net"]
                                        if inc.get("year_anchor_nav_net") else None)
                            inc_c2.metric(f"{inc['year']} YTD 금융수익금",
                                            fmt_krw(inc["ytd_income"]),
                                            fmt_pct(ytd_pct) if ytd_pct is not None else None)
                        else:
                            inc_c2.metric(f"{inc['year']} YTD 금융수익금", "—",
                                            help="연초 직전 NAV 없음")
                        inc_c3.metric("연초 anchor",
                                        inc.get("year_anchor_date") or "—",
                                        help=(f"순자산: {fmt_krw(inc['year_anchor_nav_net'])}"
                                              if inc.get("year_anchor_nav_net")
                                              else None))
                except Exception as _e:
                    st.caption(f"⚠️ 금융수익금 계산 실패: {_e}")
            else:
                st.info("기준가 차트는 최소 2 영업일 이상일 때 표시됨.")

            with st.expander("📋 일별 데이터 (derived)"):
                show_h = nav_hist.copy()
                show_h["날짜"] = pd.to_datetime(show_h["날짜"]).dt.strftime("%Y-%m-%d")
                st.dataframe(show_h, use_container_width=True, hide_index=True,
                              column_config={
                                  "총자산": st.column_config.NumberColumn(format="₩%,d"),
                                  "순자산": st.column_config.NumberColumn(format="₩%,d"),
                                  "부채": st.column_config.NumberColumn(format="₩%,d"),
                                  "외부유입_총": st.column_config.NumberColumn(format="₩%,d"),
                                  "외부유입_순": st.column_config.NumberColumn(format="₩%,d"),
                                  "좌수_총": st.column_config.NumberColumn(format="%.4f"),
                                  "좌수_순": st.column_config.NumberColumn(format="%.4f"),
                                  "기준가_총자산": st.column_config.NumberColumn(format="%.2f"),
                                  "기준가_순자산": st.column_config.NumberColumn(format="%.2f"),
                              })

        # Debt input
        st.divider()
        st.markdown("##### 💸 부채 잔액 입력/변경")
        st.caption(
            "부채는 별도 시계열. 입력한 날짜로 그 시점 부채 = 그 값. "
            "이후로는 LOCF (다음 입력 전까지 같은 값 유지). "
            "순자산 = 총자산 − 부채."
        )
        dc1, dc2, dc3 = st.columns([2, 2, 1])
        with dc1:
            debt_date = st.date_input("날짜", value=today_kst(),
                                        key="debt_d")
        with dc2:
            _last_debt = float(debt_df.iloc[-1]["부채"]) if not debt_df.empty else 0.0
            debt_amount_str = st.text_input(
                "부채 잔액 (원)", value=f"{int(_last_debt):,}",
                placeholder="예: 85,000,000", key="debt_amt",
                help="직전 값 자동 채움")
            debt_memo = st.text_input("메모", placeholder="예: 전세대출 잔액",
                                        key="debt_memo")
        with dc3:
            st.caption("")
            st.caption("")
            if st.button("💾 적용", type="primary", use_container_width=True,
                           key="upsert_debt"):
                try:
                    debt_val = float(debt_amount_str.replace(",", "").strip())
                except (ValueError, AttributeError):
                    debt_val = None
                if debt_val is None or debt_val < 0:
                    st.error("부채 잔액을 0 이상 숫자로 입력해주세요")
                else:
                    res = upsert_debt(pd.Timestamp(debt_date), debt_val,
                                       debt_memo)
                    st.cache_data.clear()
                    st.success(f"✅ {res['date']} 부채: ₩{debt_val:,.0f}")
                    st.rerun()

        if not debt_df.empty:
            with st.expander("📋 부채 이력"):
                show_d = debt_df.copy()
                show_d["날짜"] = pd.to_datetime(show_d["날짜"]).dt.strftime("%Y-%m-%d")
                st.dataframe(show_d, use_container_width=True, hide_index=True,
                              column_config={
                                  "부채": st.column_config.NumberColumn(format="₩%,d"),
                              })


# -------- Tab 5: Stock Notes --------
with tab_notes:
    st.subheader("🎯 종목 메모 · 목표가")
    st.caption("종목별 목표가(상단/하단)와 업사이드/다운사이드 메모. "
                "보유 종목 자동 채움 + 워치리스트 자유 추가.")

    notes_df = load_stock_notes()
    held_tickers = [t for t in holdings_raw.index
                    if t not in CASH_TICKERS and t not in ACCOUNT_TICKERS
                    and "→" not in str(t)]
    notes_known = set(notes_df["종목"].astype(str)) if not notes_df.empty else set()
    missing = [t for t in held_tickers if t not in notes_known]
    if missing:
        add_rows = pd.DataFrame([{
            "종목": t, "목표가_상단": float("nan"), "목표가_하단": float("nan"),
            "업사이드_메모": "", "다운사이드_메모": "", "업데이트일": "",
        } for t in missing])
        notes_df = (pd.concat([notes_df, add_rows], ignore_index=True)
                     if not notes_df.empty else add_rows)

    cat_map = load_category_map()
    view = notes_df.copy()
    view["카테고리"] = view["종목"].map(lambda t: cat_map.get(str(t), "기타"))
    view["통화"] = view["종목"].map(
        lambda t: str(holdings_raw.loc[t, "통화"])
            if t in holdings_raw.index else "")
    view["평균단가"] = view["종목"].map(
        lambda t: float(holdings_raw.loc[t, "평균단가"])
            if t in holdings_raw.index else float("nan"))
    view["현재가"] = view["종목"].map(
        lambda t: float(prices.get(t)) if prices.get(t) else float("nan"))

    def _upside_pct(row):
        cur = row["현재가"]; tgt = row["목표가_상단"]
        if pd.isna(cur) or pd.isna(tgt) or cur <= 0:
            return float("nan")
        return (tgt - cur) / cur * 100

    def _downside_pct(row):
        cur = row["현재가"]; tgt = row["목표가_하단"]
        if pd.isna(cur) or pd.isna(tgt) or cur <= 0:
            return float("nan")
        return (tgt - cur) / cur * 100

    def _rr_ratio(row):
        u = row["업사이드_%"]; d = row["다운사이드_%"]
        if pd.isna(u) or pd.isna(d) or d >= 0:
            return float("nan")
        return u / abs(d)

    view["업사이드_%"] = view.apply(_upside_pct, axis=1)
    view["다운사이드_%"] = view.apply(_downside_pct, axis=1)
    view["R/R"] = view.apply(_rr_ratio, axis=1)

    display_cols = ["종목", "카테고리", "통화", "평균단가", "현재가",
                     "목표가_상단", "업사이드_%", "목표가_하단", "다운사이드_%",
                     "R/R", "업사이드_메모", "다운사이드_메모", "업데이트일"]
    view = view[display_cols]

    edited_notes = st.data_editor(
        view, use_container_width=True, hide_index=True, num_rows="dynamic",
        key="notes_editor",
        column_config={
            "종목": st.column_config.TextColumn(width="medium"),
            "카테고리": st.column_config.TextColumn(width="small"),
            "통화": st.column_config.TextColumn(width="small"),
            "평균단가": st.column_config.NumberColumn(format="%.4g"),
            "현재가": st.column_config.NumberColumn(format="%.4g"),
            "목표가_상단": st.column_config.NumberColumn(
                "🎯 목표가 (상단)", format="%.4g"),
            "업사이드_%": st.column_config.NumberColumn(format="%+.1f%%"),
            "목표가_하단": st.column_config.NumberColumn(
                "🛡️ 목표가 (하단)", format="%.4g"),
            "다운사이드_%": st.column_config.NumberColumn(format="%+.1f%%"),
            "R/R": st.column_config.NumberColumn(format="%.2f"),
            "업사이드_메모": st.column_config.TextColumn(
                "📈 업사이드 메모", width="large"),
            "다운사이드_메모": st.column_config.TextColumn(
                "📉 다운사이드 메모", width="large"),
            "업데이트일": st.column_config.TextColumn(width="small"),
        },
        disabled=["카테고리", "통화", "평균단가", "현재가",
                   "업사이드_%", "다운사이드_%", "R/R"],
    )

    if st.button("💾 메모 저장", type="primary", key="save_notes"):
        to_save = edited_notes.copy()
        to_save = to_save[STOCK_NOTES_HEADERS[:5] + ["업데이트일"]]
        today_str = today_kst().strftime("%Y-%m-%d")
        to_save["업데이트일"] = to_save["업데이트일"].astype(str).where(
            to_save["업데이트일"].astype(str).str.strip() != "", today_str)
        save_stock_notes(to_save)
        st.cache_data.clear()
        st.success(
            f"✅ {len(to_save[to_save['종목'].astype(str).str.strip() != ''])}개 "
            "종목 메모 저장됨")
        st.rerun()


# -------- Tab 6: Settings --------
with tab_settings:
    st.subheader("⚙️ 설정")

    st.markdown("##### ☁️ Google Sheets")
    if GOOGLE_SHEET_ID:
        st.code(f"Sheet ID: {GOOGLE_SHEET_ID}")
        st.caption(f"https://docs.google.com/spreadsheets/d/{GOOGLE_SHEET_ID}")
    else:
        st.warning("GOOGLE_SHEET_ID가 .env에 없음")

    st.divider()
    st.markdown("##### 🏷 카테고리 매핑")
    cat_map = load_category_map()
    cat_df = pd.DataFrame(
        [{"종목": k, "카테고리": v} for k, v in sorted(cat_map.items())]
        if cat_map else
        [{"종목": "", "카테고리": ""}],
        columns=["종목", "카테고리"],
    )
    edited_cat = st.data_editor(cat_df, num_rows="dynamic",
                                  use_container_width=True, hide_index=True,
                                  key="cat_editor")
    if st.button("💾 카테고리 저장", key="save_cat"):
        new_map = {}
        for _, row in edited_cat.iterrows():
            t = str(row["종목"]).strip()
            c = str(row["카테고리"]).strip()
            if t:
                new_map[t] = c
        save_category_map(new_map)
        st.cache_data.clear()
        st.success(f"✅ {len(new_map)}개 카테고리 저장됨")
        st.rerun()

    st.divider()
    st.markdown("##### 📈 yfinance 심볼 매핑")
    tm = load_ticker_map()
    tm_df = pd.DataFrame(
        [{"종목": k, "yfinance_symbol": v} for k, v in sorted(tm.items())]
        if tm else
        [{"종목": "", "yfinance_symbol": ""}],
        columns=["종목", "yfinance_symbol"],
    )
    edited_tm = st.data_editor(tm_df, num_rows="dynamic",
                                 use_container_width=True, hide_index=True,
                                 key="tm_editor")
    if st.button("💾 yfinance 심볼 저장", key="save_tm"):
        new_map = {}
        for _, row in edited_tm.iterrows():
            t = str(row["종목"]).strip()
            s = str(row["yfinance_symbol"]).strip()
            if t:
                new_map[t] = s
        save_ticker_map(new_map)
        st.cache_data.clear()
        st.success(f"✅ {len(new_map)}개 심볼 저장됨")
        st.rerun()
