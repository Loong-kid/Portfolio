"""Read-only holdings -> news headlines -> private Telegram digest.

No portfolio values, holdings, raw articles or credentials are logged/cached.
This baseline does not pretend to have read full articles or give AI analysis.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from telegram_client import send

KST = ZoneInfo('Asia/Seoul')
EXCLUDED = {'KRW현금', 'USD현금', 'EUR현금', 'JPY현금', '개인연금', '퇴직연금'}
# Names resolve ambiguous ticker searches; this is a generic alias table, not holdings.
ALIASES = {'ARM': 'Arm Holdings', 'FLNC': 'Fluence Energy', 'AIXA.DE': 'Aixtron',
           'AMAT': 'Applied Materials', 'LRCX': 'Lam Research', 'MSFT': 'Microsoft',
           'PLTR': 'Palantir', 'OXY': 'Occidental Petroleum', 'AROC': 'Archrock',
           'KMI': 'Kinder Morgan', 'FRO': 'Frontline', 'SCCO': 'Southern Copper'}


def fingerprint(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def select_holdings(rows, today):
    valid = []
    for row in rows:
        if not any(str(v).strip() for v in row.values()):
            continue
        try:
            day = date.fromisoformat(str(row['날짜']).strip()[:10])
        except (KeyError, ValueError):
            raise RuntimeError('Invalid snapshot date') from None
        if day <= today:
            valid.append((day, row))
    if not valid:
        raise RuntimeError('No current snapshot available')
    latest = max(day for day, _ in valid)
    names = set()
    for day, row in valid:
        if day != latest:
            continue
        name = str(row.get('종목', '')).strip()
        try:
            qty = float(str(row['수량']).replace(',', ''))
        except (KeyError, ValueError):
            raise RuntimeError('Invalid snapshot quantity') from None
        if not math.isfinite(qty) or not name:
            raise RuntimeError('Invalid snapshot holding')
        if qty != 0 and name not in EXCLUDED:
            names.add(name)
    return latest, sorted(names)


def read_holdings(now):
    import gspread
    from google.oauth2.service_account import Credentials
    credentials = Credentials.from_service_account_file(os.environ['GOOGLE_SA_JSON'],
        scopes=['https://www.googleapis.com/auth/spreadsheets.readonly'])
    sheet = gspread.authorize(credentials).open_by_key(os.environ['GOOGLE_SHEET_ID'])
    rows = sheet.worksheet('snapshots').get_all_records()
    snapshot, names = select_holdings(rows, now.astimezone(KST).date())
    mapping = {str(r.get('종목', '')).strip(): str(r.get('yfinance_symbol', '')).strip()
               for r in sheet.worksheet('ticker_map').get_all_records()}
    return snapshot, [(name, mapping.get(name, '')) for name in names]


def fetch_news(name, symbol, since, until):
    korean = bool(re.search('[가-힣]', name))
    alias = ALIASES.get(symbol, ALIASES.get(name, name))
    # Short ticker-only names are ambiguous: require the financial context too.
    query = f'"{alias}"'
    if alias == name and re.fullmatch('[A-Z]{1,5}', name):
        query += ' (stock OR shares OR earnings)'
    params = {'q': query + ' when:3d', 'hl': 'ko' if korean else 'en-US',
              'gl': 'KR' if korean else 'US', 'ceid': 'KR:ko' if korean else 'US:en'}
    url = 'https://news.google.com/rss/search?' + urllib.parse.urlencode(params)
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'PortfolioBriefing/1.0'})
            with urllib.request.urlopen(request, timeout=25) as response:
                root = ET.fromstring(response.read(2_000_000))
            if root.tag != 'rss' or root.find('channel') is None:
                raise ValueError('Invalid RSS response')
            break
        except Exception:
            if attempt == 2:
                raise RuntimeError('News feed unavailable') from None
            time.sleep(2 ** attempt)
    articles = []
    for item in root.findall('./channel/item'):
        try:
            published = parsedate_to_datetime(item.findtext('pubDate', ''))
            if published.tzinfo is None:
                published = published.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError, IndexError):
            continue
        title, link = item.findtext('title', '').strip(), item.findtext('link', '').strip()
        if not title or not link.startswith('https://') or not since <= published <= until:
            continue
        source = item.findtext('source', '').strip()
        if source and title.endswith(' - ' + source):
            title = title[:-len(source)-3]
        title = re.sub(r'\s+', ' ', title)
        # Feed contents are data, never executable instructions.
        articles.append({'title': title[:500], 'link': link, 'source': source[:100],
                         'published': published, 'id': fingerprint(link),
                         'title_id': fingerprint(re.sub(r'\W+', '', title.casefold()))})
    return sorted(articles, key=lambda a: a['published'], reverse=True)


def load_state(path):
    if not path.exists():
        return {'sent': {}, 'days': []}
    state = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(state.get('sent'), dict) or not isinstance(state.get('days'), list):
        raise RuntimeError('Invalid delivery state; refusing duplicate delivery')
    return state


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(state), encoding='utf-8')
    temp.replace(path)


def choose_articles(articles, sent, limit=3):
    selected, local = [], set(sent)
    for article in articles:
        if article['id'] in local or article['title_id'] in local:
            continue
        selected.append(article)
        local.update((article['id'], article['title_id']))
        if len(selected) == limit:
            break
    return selected


def chunks(text, limit=3500):
    # UTF-16 accounting also stays below Telegram's limit for emoji-heavy text.
    current, units = '', 0
    for char in text:
        size = 2 if ord(char) > 0xffff else 1
        if units + size > limit:
            yield current
            current, units = '', 0
        current += char
        units += size
    if current:
        yield current


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--test', action='store_true')
    parser.add_argument('--state', default='.briefing-state/state.json')
    args = parser.parse_args()
    if args.test:
        send('✅ 포트폴리오 브리핑 테스트입니다.\n매일 오전 8시(한국 시간)에 최신 보유 종목의 뉴스 제목·출처·링크를 보내드립니다.\n자동 실행 사정에 따라 도착이 늦어질 수 있습니다.')
        print('Telegram test accepted')
        return
    now = datetime.now(timezone.utc)
    local_now = now.astimezone(KST)
    day = local_now.date().isoformat()
    path = Path(args.state)
    state = load_state(path)
    state['sent'] = {key: value for key, value in state['sent'].items() if value > now.timestamp()-14*86400}
    state['days'] = state['days'][-14:]
    if day in state['days'] and not args.dry_run:
        print('Already delivered for this KST date')
        return
    snapshot, holdings = read_holdings(now)
    # Overlap handles modest feed indexing delays; receipts remove repeat URLs/titles.
    since = now - timedelta(hours=36)
    sections, failures, empty = [], [], []
    candidate_ids = set(state['sent'])
    for name, symbol in holdings:
        try:
            articles = choose_articles(fetch_news(name, symbol, since, now), candidate_ids)
        except RuntimeError:
            failures.append(name)
            continue
        if not articles:
            empty.append(name)
            continue
        lines = [f'■ {name}']
        ids = []
        for article in articles:
            published = article['published'].astimezone(KST).strftime('%m/%d %H:%M')
            lines += [f"• {article['title']}", f"  {article['source']} · {published} KST", article['link']]
            ids += [article['id'], article['title_id']]
            candidate_ids.update(ids)
        sections.append(('\n'.join(lines), ids))
    header = (f'🗞 포트폴리오 아침 브리핑 | {local_now:%Y-%m-%d}\n'
              f'보유 기준: {snapshot} · 주식 {len(holdings)}종목\n'
              f'뉴스 범위: {since.astimezone(KST):%m/%d %H:%M} ~ {local_now:%m/%d %H:%M} KST\n'
              '뉴스 제목 모음 · Google News 검색 · 전문 요약/투자 해석은 포함하지 않습니다.')
    if (local_now.date()-snapshot).days > 3:
        header += '\n⚠ 보유 스냅샷이 3일 이상 지났습니다. 최신 보유 내역인지 확인해 주세요.'
    footer = []
    if empty:
        footer.append('새 검색 결과 없음(수집 범위 내·중복 제외): ' + ', '.join(empty))
    if failures:
        footer.append('⚠ 수집 실패: ' + ', '.join(failures) + '\n이 종목들은 소식 유무를 확인하지 못했습니다.')
    if not holdings:
        footer.append('현재 뉴스 대상 주식이 없습니다.')
    blocks = [(header, [])] + sections + [('\n'.join(footer), [])]
    if args.dry_run:
        # Public Actions logs must not reveal holdings or personalized text.
        print(f'Preview validated: holdings={len(holdings)}, sections={len(sections)}, feeds_failed={len(failures)}')
        if failures:
            raise RuntimeError('One or more news feeds failed')
        return
    for text, ids in blocks:
        if not text:
            continue
        for part in chunks(text):
            receipt = fingerprint(day + '\n' + part)
            if receipt in state['sent']:
                continue
            send(part)
            state['sent'][receipt] = now.timestamp()
            save_state(path, state)
            time.sleep(1.1)
        for article_id in ids:
            state['sent'][article_id] = now.timestamp()
        save_state(path, state)
    if not failures:
        state['days'].append(day)
    save_state(path, state)
    print(f'Delivery accepted: sections={len(sections)}, feeds_failed={len(failures)}')
    if failures:
        raise RuntimeError('Partial briefing delivered; one or more feeds failed')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Library errors can contain spreadsheet IDs or credential URLs. Log type only.
        print(f'Briefing failed ({type(error).__name__}); verify credentials, feeds and delivery settings.')
        raise SystemExit(1)
