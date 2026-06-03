# 포트폴리오 모니터 — 클라우드 (snapshot-primary)

구글 시트 1개를 DB로 쓰는 Streamlit 대시보드.

## 아키텍처
**Snapshot-primary**. 거래 내역 replay 없음.

- `snapshots` 탭 = **유일한 진실의 원천**. 각 행 = (날짜, 종목, 통화, 수량, 평균단가)
- `flows` 탭 = 외부 자금 유입/유출 (좌수/기준가 계산용). signed 금액 (+ 유입, − 유출)
- `debt_history` 탭 = 부채 LOCF 시계열

현재 포트폴리오 = 가장 최근 스냅샷 × 현재가.
자산 추이/좌수/기준가/금융수익금 = snapshots + flows + debt에서 derive.

## 처음 한 번 — 시트 준비
1. 구글 드라이브에서 **빈 시트 1개** 생성
2. 서비스 계정 JSON 파일의 `client_email`에 **편집자 권한** 공유
3. `.env` 작성:
   ```
   GOOGLE_SA_JSON=<서비스 어카운트 JSON 파일 절대경로>
   GOOGLE_SHEET_ID=<시트 ID>
   PORTFOLIO_NAME=<이름>
   ```

## 처음 한 번 — venv + 마이그레이션
```powershell
cd C:\Users\공도일\Desktop\코딩\portfolio-monitor-cloud
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 기존 transactions-primary 시트에서 옮겨오기 (1회):
python migrate_to_snapshot.py --dry-run    # 미리보기
python migrate_to_snapshot.py              # 실제 실행
```

마이그레이션 동작:
- 옛 `transactions` 탭 replay → 오늘 시점 스냅샷 1건으로 시드
- 옛 `net_asset_history`의 마지막 부채 값 → `debt_history` 시드
- 옛 탭 5종 삭제: `transactions`, `balance_snapshot`, `net_asset_history`, `Balance sheet daily`, `Balance sheet(history)`

## 매번
**`dashboard.bat` 더블클릭** — venv 자동, Streamlit 서버 실행, 브라우저 열림.

## UI 6탭
1. **💼 현재 포트폴리오** — 최근 스냅샷 × 현재가 (보유 종목 표, 카테고리 비중, 종목별 비중)
2. **📸 스냅샷** — 기존 스냅샷 편집 / 새 스냅샷 추가 (data_editor로 직접 입력)
3. **💸 외부 자금 흐름** — flows 리스트 + 추가/편집 (좌수 계산용)
4. **📈 자산 추이** — 일별 NAV / 기준가 (TWR) / 금융수익금 / 부채 입력
5. **🎯 종목 메모** — 목표가 + 업사이드/다운사이드 메모
6. **⚙️ 설정** — 카테고리·yfinance 심볼 매핑

## 사용 워크플로우
- 포트폴리오가 바뀌면 **📸 스냅샷** 탭에서 새 스냅샷 추가 (날짜는 변경된 날 또는 오늘)
- 외부에서 돈이 들어오거나 나가면 **💸 외부 자금 흐름** 탭에 기록 (좌수/기준가 정확도용)
- 부채가 바뀌면 **📈 자산 추이** 탭 하단의 부채 입력 폼 사용

## 파일 구조
```
portfolio-monitor-cloud/
├── app.py                  # Streamlit UI (6탭)
├── sheets_db.py            # Sheets 어댑터 (SCHEMAS, read/write/append/delete + 60s 캐시)
├── portfolio.py            # snapshot/flows/debt + NAV/좌수/기준가 derive
├── config.py               # 환경변수 + 카테고리/티커맵
├── data_fetcher.py         # yfinance 가격/환율
├── migrate_to_snapshot.py  # 1회 마이그레이션 (transactions → snapshots)
├── dashboard.bat
├── requirements.txt
└── .env
```

## 주의
- 시트 API 호출은 비쌈 (~300ms). `sheets_db.read_tab`은 60s 캐시
- Google API rate limit: 분당 60회. 혼자 쓰면 문제 없음
- 좌수/기준가는 **외부 자금 흐름이 정확해야 의미 있음** — 근로소득·이체·대출 입금/상환 모두 `flows`에 기록
