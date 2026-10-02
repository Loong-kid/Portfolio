"""Official DART / SEC filing lists. No summaries or importance inference."""
from __future__ import annotations
import hashlib
import io
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import date

DEFAULT_UA = ('PortfolioBriefing/1.0 '
              '(https://github.com/Loong-kid/Portfolio; '
              'contact: https://github.com/Loong-kid/Portfolio/issues)')


class FilingError(RuntimeError):
    """Only safe, fixed diagnostics: never raw URLs containing API keys."""


def download(url, source):
    headers = {'User-Agent': os.environ.get('SEC_USER_AGENT') or DEFAULT_UA,
               'Accept': 'application/json,application/xml,*/*'}
    for attempt in range(3):
        # Well below SEC's 10 requests/second limit, even during pagination.
        time.sleep(0.25)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=35) as response:
                return response.read(30_000_000)
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise FilingError(f'{source} HTTP {error.code}') from None
        except Exception:
            if attempt == 2:
                raise FilingError(f'{source} 연결 실패') from None
        time.sleep(2 ** attempt)


def get_json(url, source):
    try:
        value = json.loads(download(url, source))
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except FilingError:
        raise
    except Exception:
        raise FilingError(f'{source} 응답 형식 오류') from None


def filing(source, identity, title, day, link):
    return {'source': source, 'id': hashlib.sha256(f'{source}:{identity}'.encode()).hexdigest(),
            'title': title, 'date': day, 'link': link}


class Dart:
    def __init__(self):
        self.key = os.environ.get('DART_API_KEY', '').strip()
        if not self.key:
            raise FilingError('DART 인증키 미설정')
        self.codes = None
        self.code_error = None

    def url(self, endpoint, **params):
        return 'https://opendart.fss.or.kr/api/' + endpoint + '?' + urllib.parse.urlencode(
            {'crtfc_key': self.key, **params})

    def corp_code(self, symbol):
        stock = symbol.split('.')[0]
        if not re.fullmatch(r'\d{6}', stock):
            raise FilingError('DART 종목코드 매핑 필요')
        if self.code_error:
            raise self.code_error
        if self.codes is None:
            try:
                raw = download(self.url('corpCode.xml'), 'DART')
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    member = next(n for n in archive.namelist() if n.upper().endswith('CORPCODE.XML'))
                    if archive.getinfo(member).file_size > 100_000_000:
                        raise ValueError()
                    root = ET.fromstring(archive.read(member))
                self.codes = {r.findtext('stock_code', '').strip(): r.findtext('corp_code', '').strip()
                              for r in root.findall('list') if r.findtext('stock_code', '').strip()}
            except FilingError as error:
                self.code_error = error
                raise
            except Exception:
                self.code_error = FilingError('DART 회사코드 조회 실패')
                raise self.code_error from None
        code = self.codes.get(stock)
        if not code or not re.fullmatch(r'\d{8}', code):
            raise FilingError('DART 회사코드 매핑 없음')
        return code

    def fetch(self, symbol, start, end):
        code = self.corp_code(symbol)
        records, page = [], 1
        while True:
            data = get_json(self.url('list.json', corp_code=code,
                bgn_de=start.strftime('%Y%m%d'), end_de=end.strftime('%Y%m%d'),
                last_reprt_at='N', page_no=page, page_count=100, sort='date', sort_mth='desc'), 'DART')
            status = data.get('status')
            if status == '013' and page == 1:
                return []
            if status != '000':
                safe = status if str(status).isdigit() else 'unknown'
                raise FilingError(f'DART 응답 코드 {safe}')
            try:
                total_pages = int(data['total_page'])
                for row in data['list']:
                    receipt = row['rcept_no']
                    if not re.fullmatch(r'\d{14}', receipt):
                        raise ValueError()
                    stamp = row['rcept_dt']
                    day = date.fromisoformat(f'{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}')
                    if start <= day <= end:
                        records.append(filing('DART', receipt, row['report_nm'], day,
                            'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=' + receipt))
            except (KeyError, ValueError, TypeError):
                raise FilingError('DART 공시 목록 형식 오류') from None
            if page >= total_pages:
                return records
            page += 1
            if page > 100:
                raise FilingError('DART 공시 페이지 한도 초과; 일부만 전송하지 않음')


class Sec:
    def __init__(self):
        self.tickers = None
        self.mapping_error = None
        try:
            self.overrides = json.loads(os.environ.get('SEC_CIK_OVERRIDES') or '{}')
            if not isinstance(self.overrides, dict) or any(not re.fullmatch(r'\d{1,10}',str(v)) for v in self.overrides.values()):
                raise ValueError()
        except Exception:
            raise FilingError('SEC CIK 설정 오류') from None

    def cik(self, symbol):
        if symbol in self.overrides:
            return str(self.overrides[symbol]).zfill(10)
        # Foreign-exchange suffixes cannot be equated to a US issuer automatically.
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9-]{0,9}', symbol):
            return None
        if self.mapping_error:
            raise self.mapping_error
        if self.tickers is None:
            try:
                data = get_json('https://www.sec.gov/files/company_tickers.json', 'SEC')
                self.tickers = {r['ticker'].upper(): str(int(r['cik_str'])).zfill(10) for r in data.values()}
            except FilingError as error:
                self.mapping_error = error
                raise
            except (KeyError, TypeError, ValueError):
                self.mapping_error = FilingError('SEC 종목 매핑 형식 오류')
                raise self.mapping_error from None
        code = self.tickers.get(symbol.upper())
        if not code:
            raise FilingError('SEC 종목 매핑 없음; CIK 확인 필요')
        return code

    @staticmethod
    def parse_rows(rows, cik, start, end):
        required = ('accessionNumber','filingDate','form','primaryDocument')
        try:
            n = len(rows['accessionNumber'])
            if any(not isinstance(rows[key], list) or len(rows[key]) != n for key in required):
                raise ValueError()
            results=[]
            for i in range(n):
                day=date.fromisoformat(rows['filingDate'][i])
                if not start <= day <= end:
                    continue
                accession=rows['accessionNumber'][i]
                if not re.fullmatch(r'\d{10}-\d{2}-\d{6}',accession):
                    raise ValueError()
                # Filing index includes the primary document and all exhibits.
                link=f'https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace("-", "")}/{accession}-index.html'
                results.append(filing('SEC', accession, 'Form ' + rows['form'][i], day, link))
            return results
        except (KeyError, ValueError, TypeError):
            raise FilingError('SEC 공시 목록 형식 오류') from None

    def fetch(self, symbol, start, end):
        cik=self.cik(symbol)
        if cik is None:
            return None
        data=get_json(f'https://data.sec.gov/submissions/CIK{cik}.json','SEC')
        try:
            filings=data['filings']
            records=self.parse_rows(filings['recent'],cik,start,end)
            # Very active issuers may move even recent filings to historical shards.
            for old in filings.get('files',[]):
                if date.fromisoformat(old['filingTo']) < start or date.fromisoformat(old['filingFrom']) > end:
                    continue
                filename=old['name']
                if not re.fullmatch(r'CIK\d{10}-submissions-\d+\.json',filename):
                    raise ValueError()
                records += self.parse_rows(get_json('https://data.sec.gov/submissions/'+filename,'SEC'),cik,start,end)
            return records
        except FilingError:
            raise
        except (KeyError, ValueError, TypeError):
            raise FilingError('SEC 제출내역 형식 오류') from None


def collect_filings(holdings, start, end, sent):
    sections, failures, empty, unsupported = [], [], [], []
    seen=set(sent)
    clients={}
    for name,symbol in holdings:
        domestic=bool(re.fullmatch(r'\d{6}(?:\.KS|\.KQ)?',symbol))
        source='DART' if domestic else 'SEC'
        if not symbol:
            failures.append(f'{name}: 공시용 종목코드 미설정')
            continue
        try:
            if source not in clients:
                try:
                    clients[source]=Dart() if domestic else Sec()
                except FilingError as error:
                    clients[source]=error
            client=clients[source]
            if isinstance(client,FilingError):
                raise client
            records=client.fetch(symbol,start,end)
            if records is None:
                unsupported.append(name)
                continue
            selected=[]
            for row in sorted(records,key=lambda r:(r['date'],r['id']),reverse=True):
                if row['id'] in seen:
                    continue
                seen.add(row['id'])
                selected.append(row)
            if not selected:
                empty.append(f'{name}({source})')
            for row in selected:
                sections.append((f"📄 {name} · {source}\n{row['title']}\n접수일: {row['date']}\n{row['link']}",[row['id']]))
        except FilingError as error:
            failures.append(f'{name}: {error}')
    return sections, failures, empty, unsupported
