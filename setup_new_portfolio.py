"""One-off: 두 번째 포트폴리오용 시트의 탭 구조 세팅 (C1 멀티배포).

서비스 어카운트는 자기 소유 파일을 못 만든다 (Drive quota 403).
그래서 시트는 사용자가 직접 만들고 SA에 공유한 뒤, 이 스크립트로 탭만 세팅한다.

사전 작업 (사용자):
  1. Google Drive에서 빈 스프레드시트 새로 생성
  2. 그 시트를 SA 이메일에 '편집자'로 공유
     (client_email: balance-sheet 서비스 어카운트)
  3. 시트 URL 또는 ID 확보

실행:
  python setup_new_portfolio.py <SHEET_ID_또는_URL>

탭 구조를 메인 포트폴리오와 동일하게 만들고, 접근 검증 후 ID를 출력한다.
(참고: 앱도 시작 시 ensure_all_tabs로 탭을 자동 생성하므로 이 스크립트는 사전 검증용.)
"""
import re
import sys
import gspread
from config import GOOGLE_SA_JSON
from sheets_db import SCHEMAS


def extract_key(s: str) -> str:
    """URL이면 /d/<KEY>/ 추출, 아니면 그대로 ID로 간주."""
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9-_]+)", s)
    return m.group(1) if m else s.strip()


def main():
    if len(sys.argv) < 2:
        print("❌ 사용법: python setup_new_portfolio.py <SHEET_ID_또는_URL>")
        sys.exit(1)

    key = extract_key(sys.argv[1])
    print(f"🔑 서비스 어카운트 인증: {GOOGLE_SA_JSON}")
    gc = gspread.service_account(filename=GOOGLE_SA_JSON)

    print(f"📄 시트 열기: {key}")
    try:
        sh = gc.open_by_key(key)
    except gspread.exceptions.APIError as e:
        print(f"❌ 시트를 못 엶: {e}")
        print("   → 시트를 SA 이메일에 '편집자'로 공유했는지 확인해줘.")
        sys.exit(1)
    print(f"   제목: {sh.title}")

    existing = {ws.title for ws in sh.worksheets()}
    for tab, headers in SCHEMAS.items():
        if tab in existing:
            ws = sh.worksheet(tab)
        else:
            ws = sh.add_worksheet(title=tab, rows=200,
                                  cols=max(len(headers), 6))
        ws.update([headers], "A1")
        print(f"   ✅ {tab}: {headers}")

    # 기본 Sheet1 제거 (스키마에 없으면)
    names_now = {ws.title for ws in sh.worksheets()}
    if "Sheet1" in names_now and "Sheet1" not in SCHEMAS:
        try:
            sh.del_worksheet(sh.worksheet("Sheet1"))
            print("   🧹 기본 Sheet1 제거")
        except Exception as e:
            print(f"   (Sheet1 제거 스킵: {e})")

    print()
    print("=" * 64)
    print(f'GOOGLE_SHEET_ID = "{sh.id}"')
    print(f"URL: https://docs.google.com/spreadsheets/d/{sh.id}")
    print("=" * 64)
    print("→ 이 ID를 새 Streamlit Cloud 앱의 secrets에 넣어줘.")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
