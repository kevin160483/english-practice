"""把一課的資料加密後放進網站目錄。

GitHub Pages 是公開的，所以講義與老師音檔都先加密：
PBKDF2-SHA256（250k 次）導出金鑰，AES-256-GCM 加密，瀏覽器用 WebCrypto 解。
沒有密碼的人只會看到亂碼；有密碼的人在自己的瀏覽器裡解開。
"""
import json, os, secrets, sys
from pathlib import Path
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

ITERS = 250_000


def derive(password, salt):
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITERS).derive(password.encode())


def seal(key, data: bytes) -> bytes:
    iv = secrets.token_bytes(12)
    return iv + AESGCM(key).encrypt(iv, data, None)


def load_index(site_data: Path):
    idx = site_data / 'index.json'
    index = {}
    if idx.exists():
        try:
            index = json.loads(idx.read_text(encoding='utf-8')) or {}
        except json.JSONDecodeError:
            index = {}
    # salt 一旦產生就不能換，否則舊課程的密碼會失效
    index.setdefault('kdf', {'salt': secrets.token_hex(16), 'iters': ITERS})
    index.setdefault('lessons', [])
    return index


def run(lesson_dir, site_data, password):
    lesson_dir, site_data = Path(lesson_dir), Path(site_data)
    index = load_index(site_data)
    salt = bytes.fromhex(index['kdf']['salt'])
    key = derive(password, salt)
    index['check'] = seal(key, b'english-practice').hex()

    lesson = json.loads((lesson_dir / 'lesson.json').read_text(encoding='utf-8'))
    lid = lesson['id']
    dst = site_data / lid
    dst.mkdir(parents=True, exist_ok=True)

    n = 0
    for item_id, meta in lesson.get('audio', {}).items():
        src = lesson_dir / meta['src']
        if not src.exists():
            continue
        out = dst / (meta['src'] + '.enc')
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(seal(key, src.read_bytes()))
        n += 1

    (dst / 'lesson.enc').write_bytes(seal(key, json.dumps(lesson, ensure_ascii=False).encode()))

    entry = {'id': lid, 'path': f'{lid}/lesson.enc', 'audio': n,
             'added': os.environ.get('LESSON_DATE') or __import__('datetime').date.today().isoformat()}
    index['lessons'] = [l for l in index['lessons'] if l['id'] != lid] + [entry]
    index['lessons'].sort(key=lambda l: (len(l['id']), l['id']))
    site_data.mkdir(parents=True, exist_ok=True)
    (site_data / 'index.json').write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'{lid} 已加密：1 份講義 + {n} 個音檔 → {site_data}')


if __name__ == '__main__':
    pw = os.environ.get('LESSON_PASSWORD')
    if not pw:
        raise SystemExit('請設定環境變數 LESSON_PASSWORD')
    run(sys.argv[1], sys.argv[2], pw)
