"""把 inbox/ 裡的講義（和同名的上課錄音）處理成課程，處理完清空 inbox。

配對規則：講義 `L3.docx` 會自動找 `L3.m4a` / `L3.mp3` / `L3.mp4` …；
沒有同名音檔時，如果 inbox 只有一份音檔就用它，否則先只處理文字。
"""
import os, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import build_lesson

ROOT = Path(__file__).resolve().parent.parent
INBOX = ROOT / 'inbox'
MEDIA = {'.m4a', '.mp3', '.mp4', '.wav', '.mov', '.aac', '.ogg', '.opus', '.webm', '.mkv'}


def main():
    docs = sorted(p for p in INBOX.glob('*.doc*') if not p.name.startswith('~$'))
    media = sorted(p for p in INBOX.iterdir() if p.suffix.lower() in MEDIA)
    if not docs:
        print('inbox 裡沒有講義，跳過')
        return 0

    notes = []
    for d in docs:
        pair = next((m for m in media if m.stem.lower() == d.stem.lower()), None)
        if not pair and len(media) == 1 and len(docs) == 1:
            pair = media[0]
        print(f'\n===== {d.name}' + (f'  +  {pair.name}' if pair else '  （無錄音）') + ' =====')
        lid = build_lesson.run(str(d), str(pair) if pair else None,
                               os.environ.get('LESSON_ID'), os.environ.get('PIPER_VOICE'),
                               os.environ.get('WHISPER_MODEL'))
        if lid:
            import json as _json
            lesson = _json.loads((ROOT / 'build' / lid / 'lesson.json').read_text(encoding='utf-8'))
            teacher = sum(1 for a in lesson.get('audio', {}).values() if a.get('kind') == 'teacher')
            notes.append(f'{lid} 好了，{teacher} 句有老師原聲')

    if notes:
        (ROOT / 'build').mkdir(exist_ok=True)
        (ROOT / 'build' / 'notify.txt').write_text('；'.join(notes), encoding='utf-8')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
