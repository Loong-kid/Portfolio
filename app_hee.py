"""두 번째 배포 진입점 (C1 멀티배포).

Streamlit Cloud는 (repo, branch, main file) 조합으로 앱을 식별한다.
기존 앱이 main file = app.py 를 쓰므로, 같은 repo로 두 번째 앱을 띄우려면
main file 경로가 달라야 한다. 이 파일은 본체 코드(app.py)를 그대로 실행만 한다.

어떤 시트를 볼지 / 화면 이름은 각 앱의 secrets(GOOGLE_SHEET_ID, PORTFOLIO_NAME)가
결정한다. 즉 코드는 단일 소스(app.py)이고, 이 파일은 식별용 래퍼일 뿐이다.

→ 새 Streamlit Cloud 앱에서 Main file path 를 `app_hee.py` 로 지정.
"""
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).with_name("app.py")), run_name="__main__")
