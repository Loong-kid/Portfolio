"""Password-gate authentication for the portfolio dashboard.

Two roles:
  - admin: full access
  - guest: 💼 현재 포트폴리오 탭만 + 숫자 강제 블러

Passwords are stored as SHA-256 hashes in `.streamlit/secrets.toml`:
  admin_password_hash = "<sha256 hex>"
  guest_password_hash = "<sha256 hex>"

Generate a hash:
    python -c "import hashlib; print(hashlib.sha256(b'mypass').hexdigest())"
"""
from __future__ import annotations
import hashlib
import streamlit as st


def _hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def get_role() -> str | None:
    """Returns 'admin' / 'guest' / None (not logged in)."""
    return st.session_state.get("role")


def is_admin() -> bool:
    return get_role() == "admin"


def is_guest() -> bool:
    return get_role() == "guest"


def login_form() -> None:
    """Render login form. Sets st.session_state['role'] on success."""
    st.title("🔒 포트폴리오 모니터")
    st.caption(
        "관리자/게스트 비밀번호로 로그인. "
        "게스트는 현재 포트폴리오 화면(블러 처리)만 볼 수 있어요."
    )
    with st.form("login_form", clear_on_submit=False):
        pw = st.text_input("비밀번호", type="password",
                             placeholder="비밀번호 입력")
        ok = st.form_submit_button("🔓 로그인", type="primary",
                                      use_container_width=True)
        if ok:
            pw_hash = _hash(pw)
            try:
                admin_hash = str(st.secrets.get("admin_password_hash", ""))
                guest_hash = str(st.secrets.get("guest_password_hash", ""))
            except Exception:
                admin_hash = ""
                guest_hash = ""
            if not admin_hash and not guest_hash:
                st.error(
                    "❌ secrets 미설정. `.streamlit/secrets.toml`에 "
                    "`admin_password_hash` / `guest_password_hash` 추가 필요."
                )
                return
            if admin_hash and pw_hash == admin_hash:
                st.session_state["role"] = "admin"
                st.rerun()
            elif guest_hash and pw_hash == guest_hash:
                st.session_state["role"] = "guest"
                st.rerun()
            else:
                st.error("❌ 비밀번호가 틀렸습니다.")


def logout_button() -> None:
    if st.button("🚪 로그아웃", use_container_width=True):
        st.session_state.pop("role", None)
        st.rerun()


def require_login() -> str:
    """Call at the top of the app. Returns role; stops execution if not
    logged in (login form is shown instead)."""
    role = get_role()
    if role is None:
        login_form()
        st.stop()
    return role
