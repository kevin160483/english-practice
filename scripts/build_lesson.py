"""一堂課的完整處理流程。

    python3 scripts/build_lesson.py inbox/L3.docx inbox/L3.m4a

步驟：解析講義 → 對齊上課錄音切句 → 缺的句子補合成範讀 → 加密進網站目錄。
音檔可以不給，之後補上再跑一次就好（老師原聲會覆蓋掉合成的）。
"""
import os, sys, shutil
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import parse_docx, tts_fallback, pack

ROOT = Path(__file__).resolve().parent.parent


def run(docx, audio=None, lesson_id=None, voice=None, model=None):
    build = ROOT / 'build'
    lesson, counts, warn = parse_docx.parse(docx, lesson_id)
    lid = lesson['id']
    out = build / lid
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / 'lesson.json').write_text(
        __import__('json').dumps(lesson, ensure_ascii=False, indent=1), encoding='utf-8')

    print(f'\n[1/4] 講義 {lid}：{counts}')
    for w in warn:
        print('   ! ' + w)

    if audio:
        print(f'\n[2/4] 對齊上課錄音 {Path(audio).name}')
        import align_audio
        align_audio.run(out / 'lesson.json', audio, out, model or align_audio.MODEL)
    else:
        print('\n[2/4] 沒有上課錄音，跳過（之後補上再跑一次即可）')

    print('\n[3/4] 補上合成範讀')
    tts_fallback.run(out / 'lesson.json', out, voice or tts_fallback.VOICE,
                     os.environ.get('TTS_ANSWERS', '1') != '0')

    print('\n[4/4] 加密進網站')
    pw = os.environ.get('LESSON_PASSWORD')
    if not pw:
        raise SystemExit('請設定 LESSON_PASSWORD（GitHub 上設成 repository secret）')
    pack.run(out, ROOT / 'docs' / 'data', pw)
    print(f'\n完成。把 docs/ 推上去，網站就多一課 {lid}。')
    return lid


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opts = dict(a.lstrip('-').split('=', 1) for a in sys.argv[1:] if a.startswith('--') and '=' in a)
    run(args[0], args[1] if len(args) > 1 else None,
        opts.get('id'), opts.get('voice'), opts.get('model'))
