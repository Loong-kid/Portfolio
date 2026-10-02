import io
import os
import unittest
import urllib.error
import zipfile
from datetime import date
from unittest.mock import patch
import filings as f

START, END = date(2026,9,27), date(2026,10,3)


def dart_row(receipt='20260929000547', title='보고서'):
    return {'rcept_no': receipt, 'report_nm':title, 'rcept_dt':'20260929'}


def sec_rows(accessions=None, days=None, forms=None):
    return {'accessionNumber':accessions or ['0001104659-26-108270'],
            'filingDate':days or ['2026-09-29'], 'form':forms or ['8-K'],
            'primaryDocument':['report.htm'] * len(accessions or [1])}


class FilingTests(unittest.TestCase):
    def setUp(self):
        env=patch.dict(os.environ, {'DART_API_KEY':'test-key','SEC_CIK_OVERRIDES':'{}','SEC_ENABLED':'true'})
        env.start(); self.addCleanup(env.stop)

    def dart(self):
        client=f.Dart(); client.codes={'005930':'00126380'}; return client

    def test_dart_code_leading_zero(self):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,'w') as archive:
            archive.writestr('CORPCODE.xml','<result><list><stock_code>005930</stock_code><corp_code>00126380</corp_code></list></result>')
        with patch.object(f,'download',return_value=stream.getvalue()):
            self.assertEqual(f.Dart().corp_code('005930.KS'),'00126380')

    def test_dart_all_pages_and_amendments(self):
        responses=[{'status':'000','total_page':2,'list':[dart_row()]},
                   {'status':'000','total_page':2,'list':[dart_row('20260929000548','[기재정정]보고서')]}]
        with patch.object(f,'get_json',side_effect=responses) as get:
            records=self.dart().fetch('005930.KS',START,END)
        self.assertEqual(len(records),2)
        self.assertNotEqual(records[0]['id'],records[1]['id'])
        self.assertIn('page_no=2',get.call_args_list[1].args[0])
        self.assertIn('last_reprt_at=N',get.call_args_list[0].args[0])

    def test_dart_empty_is_not_quota_failure(self):
        with patch.object(f,'get_json',return_value={'status':'013'}):
            self.assertEqual(self.dart().fetch('005930.KS',START,END),[])
        with patch.object(f,'get_json',return_value={'status':'020'}):
            with self.assertRaises(f.FilingError): self.dart().fetch('005930.KS',START,END)

    def test_dart_malformed_receipt_fails(self):
        with patch.object(f,'get_json',return_value={'status':'000','total_page':1,'list':[dart_row('bad')]}):
            with self.assertRaises(f.FilingError): self.dart().fetch('005930.KS',START,END)

    def test_sec_date_boundaries_and_index_link(self):
        rows=sec_rows(['0001104659-26-108270','0001104659-26-108271','0001104659-26-108272'],
                      ['2026-09-27','2026-10-03','2026-10-04'],['6-K','20-F/A','4'])
        result=f.Sec.parse_rows(rows,'0001973239',START,END)
        self.assertEqual(len(result),2)
        self.assertEqual(result[1]['title'],'Form 20-F/A')
        self.assertIn('/1973239/000110465926108270/',result[0]['link'])
        self.assertTrue(result[0]['link'].endswith('-index.html'))

    def test_sec_invalid_parallel_arrays_not_silently_empty(self):
        rows=sec_rows(); rows['form']=[]
        with self.assertRaises(f.FilingError): f.Sec.parse_rows(rows,'0001973239',START,END)

    def test_sec_foreign_exchange_requires_explicit_mapping(self):
        with patch.object(f,'get_json') as get:
            self.assertIsNone(f.Sec().fetch('AIXA.DE',START,END))
        get.assert_not_called()
        with patch.dict(os.environ,{'SEC_CIK_OVERRIDES':'{"FOREIGN.DE":"12345"}'}):
            self.assertEqual(f.Sec().cik('FOREIGN.DE'),'0000012345')

    def test_sec_dynamic_ticker_lookup_and_cache(self):
        client=f.Sec()
        with patch.object(f,'get_json',return_value={'0':{'ticker':'ARM','cik_str':1973239}}) as get:
            self.assertEqual(client.cik('ARM'),'0001973239')
            self.assertEqual(client.cik('arm'),'0001973239')
        self.assertEqual(get.call_count,1)

    def test_sec_overlapping_historical_shards(self):
        client=f.Sec(); client.tickers={'ARM':'0001973239'}
        payload={'filings':{'recent':sec_rows(), 'files':[
            {'name':'CIK0001973239-submissions-001.json','filingFrom':'2026-09-01','filingTo':'2026-09-30'},
            {'name':'CIK0001973239-submissions-002.json','filingFrom':'2020-01-01','filingTo':'2020-12-31'}]}}
        with patch.object(f,'get_json',side_effect=[payload,sec_rows(['0001104659-26-108271'])]) as get:
            records=client.fetch('ARM',START,END)
        self.assertEqual(len(records),2)
        self.assertEqual(get.call_count,2)

    def test_same_title_different_accessions_are_not_dropped(self):
        a=f.filing('DART','1','보고서',START,'https://example.com/1')
        b=f.filing('DART','2','보고서',START,'https://example.com/2')
        with patch.object(f.Dart,'fetch',return_value=[a,a,b]):
            sections,failures,empty,unmapped=f.collect_filings([('Company','005930.KS')],START,END,{})
        self.assertEqual(len(sections),2)
        self.assertEqual(failures,[])
        with patch.object(f.Dart,'fetch',return_value=[a,b]):
            sections,*_=f.collect_filings([('Company','005930.KS')],START,END,{a['id']:1})
        self.assertEqual(len(sections),1)

    def test_failures_empty_and_unsupported_are_separate(self):
        with patch.object(f.Dart,'fetch',side_effect=f.FilingError('DART HTTP 503')), patch.object(f.Sec,'fetch',side_effect=[[],None]):
            sections,failures,empty,unmapped=f.collect_filings([('Korean','005930.KS'),('US','ARM'),('German','AIXA.DE')],START,END,{})
        self.assertEqual(len(failures),1)
        self.assertEqual(empty,['US(SEC)'])
        self.assertEqual(unmapped,['German (SEC 매핑 미설정·미국 외 거래소)'])

    def test_sec_paused_never_initializes_or_calls_sec(self):
        with patch.dict(os.environ, {'SEC_ENABLED':'false'}), patch.object(f,'Sec') as sec:
            sections,failures,empty,unmapped=f.collect_filings([('US','ARM')],START,END,{})
        sec.assert_not_called()
        self.assertEqual((sections,failures,empty),([],[],[]))
        self.assertEqual(unmapped,['US (SEC 조회 보류)'])

    def test_download_error_cannot_leak_key(self):
        url='https://opendart.fss.or.kr/api/list.json?crtfc_key=private-key'
        with patch.object(f.urllib.request,'urlopen',side_effect=urllib.error.HTTPError(url,403,'forbidden',{},None)), patch.object(f.time,'sleep'):
            with self.assertRaises(f.FilingError) as error: f.download(url,'DART')
        self.assertNotIn('private-key',str(error.exception))


if __name__=='__main__': unittest.main()
