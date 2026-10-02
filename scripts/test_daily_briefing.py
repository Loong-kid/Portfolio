import json
import os
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch, MagicMock

import daily_briefing as b
import telegram_client as t


class BriefingTests(unittest.TestCase):
    def setUp(self):
        patcher = patch.object(b, 'collect_filings', return_value=([], [], [], []))
        self.collect = patcher.start()
        self.addCleanup(patcher.stop)

    def test_latest_whole_snapshot_excludes_sold_cash_and_future(self):
        rows = [
            {'날짜':'2026-09-22', '종목':'Sold', '수량':'3'},
            {'날짜':'2026-09-23', '종목':'Held', '수량':'1,200'},
            {'날짜':'2026-09-23', '종목':'Zero', '수량':'0'},
            {'날짜':'2026-09-23', '종목':'KRW현금', '수량':'100'},
            {'날짜':'2026-09-23', '종목':'개인연금', '수량':'1'},
            {'날짜':'2026-09-25', '종목':'Future', '수량':'1'}]
        self.assertEqual(b.select_holdings(rows, date(2026,9,24)), (date(2026,9,23), ['Held']))

    def test_bad_holdings_fail_closed(self):
        for qty in ['NaN','', 'unknown']:
            with self.assertRaises(RuntimeError):
                b.select_holdings([{'날짜':'2026-09-23','종목':'Held','수량':qty}],date(2026,9,24))

    def test_dedup_link_and_normalized_title(self):
        rows = [{'id':'a','title_id':'x'}, {'id':'b','title_id':'x'}, {'id':'c','title_id':'y'}]
        self.assertEqual(b.choose_articles(rows, {'a'}), [rows[1], rows[2]])
        self.assertEqual(b.choose_articles(rows, {'a','x'}), [rows[2]])
        self.assertEqual(b.choose_articles(rows, {}), [rows[0],rows[2]])

    def test_rss_date_window_and_source(self):
        data = b'''<rss><channel><item><title>Arm results - Source</title><link>https://example.com/a</link><source>Source</source><pubDate>Wed, 23 Sep 2026 16:00:00 GMT</pubDate></item><item><title>Old</title><link>https://example.com/b</link><pubDate>Mon, 21 Sep 2026 16:00:00 GMT</pubDate></item><item><title>Future</title><link>https://example.com/c</link><pubDate>Fri, 25 Sep 2026 16:00:00 GMT</pubDate></item></channel></rss>'''
        response = MagicMock()
        response.__enter__.return_value.read.return_value = data
        with patch.object(b.urllib.request, 'urlopen', return_value=response):
            articles = b.fetch_news('ARM','ARM',datetime(2026,9,23,tzinfo=timezone.utc),datetime(2026,9,24,tzinfo=timezone.utc))
        self.assertEqual(len(articles),1)
        self.assertEqual(articles[0]['title'],'Arm results')

    def test_chunk_utf16_budget_and_roundtrip(self):
        text = '🗞한글 news\n'*3000
        parts = list(b.chunks(text))
        self.assertEqual(''.join(parts),text)
        self.assertTrue(all(len(p.encode('utf-16-le'))//2 <=3500 for p in parts))

    def test_no_secret_in_transport_error(self):
        with patch.dict(os.environ, {'TELEGRAM_BOT_TOKEN':'private-token'}):
            with patch.object(t.urllib.request, 'urlopen', side_effect=Exception('https://api.telegram.org/botprivate-token')):
                with self.assertRaises(RuntimeError) as e:
                    t.call('sendMessage', {})
                self.assertNotIn('private-token',str(e.exception))

    def test_state_corruption_does_not_silently_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'state.json'
            path.write_text('{broken')
            with self.assertRaises(json.JSONDecodeError):
                b.load_state(path)

    def test_completed_day_does_not_send_again(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'state.json'
            b.save_state(path, {'sent':{}, 'days':[datetime.now(b.KST).date().isoformat()]})
            with patch('sys.argv',['daily_briefing.py','--state',str(path)]), patch.object(b,'send') as send, patch.object(b,'read_holdings') as read:
                b.main()
            send.assert_not_called()
            read.assert_not_called()

    def test_partial_failure_preserves_success_receipts(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'state.json'
            article={'id':'article','title_id':'title','title':'A report','source':'Source', 'link':'https://example.com/a','published':datetime.now(timezone.utc)}
            with patch('sys.argv',['daily_briefing.py','--state',str(path)]), patch.object(b,'read_holdings',return_value=(date.today(),[('A','A'),('B','B')])), patch.object(b,'fetch_news',side_effect=[[article],RuntimeError('failed')]), patch.object(b,'send') as send, patch.object(b.time,'sleep'):
                with self.assertRaises(RuntimeError):
                    b.main()
            state=b.load_state(path)
            self.assertIn('article',state['sent'])
            self.assertEqual(state['days'],[])
            self.assertTrue(any('수집 실패' in call.args[0] for call in send.call_args_list))

    def test_dry_run_does_not_send_or_write_state(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'state.json'
            with patch('sys.argv',['daily_briefing.py','--dry-run','--state',str(path)]), patch.object(b,'read_holdings',return_value=(date.today(),[])), patch.object(b,'send') as send:
                b.main()
            send.assert_not_called()
            self.assertFalse(path.exists())


if __name__ == '__main__':
    unittest.main()
