# 매일 오전 8시 텔레그램 브리핑

`daily-briefing`은 매일 한국 시간 오전 8시(UTC 전날 23:00)에 실행 요청됩니다.
GitHub Actions의 예약 실행은 정시 도착을 보장하지 않으며, 부하에 따라 지연·누락될 수 있습니다.
공개 저장소는 활동이 60일 없으면 예약 실행이 비활성화될 수 있으므로 Actions 상태를 확인하세요.

## 내용과 범위

- 도일 포트폴리오의 최신 `snapshots` 날짜 전체를 기준으로 수량이 0이 아닌 종목만 읽습니다.
- 현금·개인연금·퇴직연금은 제외합니다. 매도된 종목을 과거 스냅샷에서 되살리지 않습니다.
- Google News RSS 검색에서 최근 36시간의 기사 제목·매체·발행시각·기사 연결 링크를 종목당 최대 3개 보냅니다.
- 이 기본형은 기사 전문을 읽은 AI 요약이나 투자 해석, 공시 전체·미래 일정 수집을 제공하지 않습니다.
- 검색 누락이 있을 수 있으므로 “검색 결과 없음”은 사건이 없다는 뜻이 아닙니다. 검색 실패는 따로 표시합니다.
- URL과 정규화한 동일 제목은 중복 제거합니다. 내용이 같지만 제목이 다른 재보도까지 판별하지는 않습니다.

## 설정

GitHub Settings → Secrets and variables → Actions:

Secrets: `GCP_SA_JSON`, `SHEET_ID_DOIL`(기존), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
Variable: `BRIEFING_ENABLED=true`일 때만 예약 발송합니다. false로 바꾸면 중지됩니다.

`telegram-pair`는 임시 `TELEGRAM_PAIR_CODE`, `TELEGRAM_PAIR_EXPIRES`를 사용합니다.
2시간 이내 일회용 코드를 보낸 개인 대화창만 확인하고, 저장소 공개키로 암호화한 ID만 로그에 남깁니다.
암호화한 값을 GitHub secret API로 `TELEGRAM_CHAT_ID`에 저장한 후 임시 pairing secrets를 삭제하세요.
봇 토큰이나 대화 ID 원문을 코드·이슈·로그에 넣지 마세요.

## 실행 및 확인

Actions → daily-briefing → Run workflow:

- `preview`: 실제 보유 종목과 뉴스 경로를 검증. 발송·상태 저장 없음. 공개 로그에는 건수만 표시.
- `test`: 연결 확인 메시지 1건 발송.
- `send`: 오늘 브리핑 발송. 이미 성공한 날짜는 중복 실행하지 않음.

포트폴리오 시트는 읽기 전용 OAuth 범위로만 접근합니다. 보유 종목·수량·자산액을 공개 로그에 남기지 않습니다.
발송 상태에는 14일 동안의 기사·메시지 해시와 완료 날짜만 저장합니다. Actions cache가 삭제/퇴거되면 중복 방지 이력이 사라질 수 있습니다.
발송 직후 통신 또는 실행이 끊기면 수신 여부를 확정할 수 없어 재실행 시 중복 가능성이 있습니다.
부분 실패 시 성공한 메시지 기록을 보존하며, 다음 재실행에서 실패 부분을 다시 시도합니다.

검증: `python -m unittest discover -s scripts -p "test_*.py"`.
