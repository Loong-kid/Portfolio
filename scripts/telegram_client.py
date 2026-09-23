"""Telegram transport. Never include token-bearing URLs in errors or logs."""
import json
import os
import urllib.error
import urllib.request


def call(method, payload):
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '').strip()
    if not token:
        raise RuntimeError('TELEGRAM_BOT_TOKEN is missing')
    request = urllib.request.Request(
        f'https://api.telegram.org/bot{token}/{method}',
        data=json.dumps(payload).encode('utf-8'),
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Telegram {method}: HTTP {error.code}') from None
    except Exception:
        raise RuntimeError(f'Telegram {method}: transport failure (delivery may be uncertain)') from None
    if not data.get('ok'):
        raise RuntimeError(f'Telegram {method}: request failed')
    return data['result']


def send(text, chat_id=None):
    recipient = chat_id or os.environ.get('TELEGRAM_CHAT_ID', '').strip()
    if not recipient:
        raise RuntimeError('TELEGRAM_CHAT_ID is missing')
    return call('sendMessage', {'chat_id': recipient, 'text': text,
        'link_preview_options': {'is_disabled': True}})
