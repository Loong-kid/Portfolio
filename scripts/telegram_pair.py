"""One-time proof of control; only an encrypted chat ID leaves the runner."""
import base64
import hmac
import os
import time
from nacl.public import PublicKey, SealedBox
from telegram_client import call, send


def main():
    code = os.environ['TELEGRAM_PAIR_CODE']
    expires = int(os.environ['TELEGRAM_PAIR_EXPIRES'])
    if not code or time.time() > expires:
        raise RuntimeError('Pairing challenge missing or expired')
    matches = set()
    updates = call('getUpdates', {'limit': 100, 'timeout': 0, 'allowed_updates': ['message']})
    for update in updates:
        message = update.get('message', {})
        chat = message.get('chat', {})
        if (chat.get('type') == 'private'
                and message.get('date', 0) >= expires - 7200
                and hmac.compare_digest(message.get('text', '').strip(), code)):
            matches.add(str(chat['id']))
    if len(matches) != 1:
        raise RuntimeError('Send the current pairing code to the bot, then rerun pairing')
    chat_id = matches.pop()
    print('::add-mask::' + chat_id)
    public_key = PublicKey(base64.b64decode(os.environ['REPO_PUBLIC_KEY']))
    encrypted = base64.b64encode(SealedBox(public_key).encrypt(chat_id.encode())).decode()
    # Ciphertext is safe to retrieve from public Actions logs; the ID itself is never printed.
    print('ENCRYPTED_CHAT_ID=' + encrypted)
    send('✅ 포트폴리오 브리핑 수신 대화창 인증이 완료됐습니다.\n매일 오전 8시(한국 시간) 브리핑을 준비하고 있어요.', chat_id)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error))
        raise SystemExit(1)
