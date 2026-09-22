"""把上課錄音對齊到講義句子，切成一句一句的 mp3。

用 Whisper 產生帶時間戳的逐字稿，再用模糊比對找出老師念每一句的位置。
老師念錯字、學生插話、中間停頓都不影響比對，因為比的是整段詞序的相似度。
"""
import json, re, subprocess, sys, unicodedata
from difflib import SequenceMatcher
from pathlib import Path

MODEL = 'small.en'          # tiny.en / base.en / small.en / medium.en
ACCEPT = 0.62               # 低於這個相似度就當作老師沒念到
PAD_HEAD, PAD_TAIL = 0.18, 0.28


def norm(text):
    text = unicodedata.normalize('NFKD', text)
    text = re.sub(r"[^a-z0-9'\s-]", ' ', text.lower())
    return [w for w in text.split() if w]


def transcribe(audio, model_size=MODEL):
    from faster_whisper import WhisperModel
    model = WhisperModel(model_size, device='cpu', compute_type='int8')
    segments, info = model.transcribe(str(audio), language='en', word_timestamps=True,
                                      vad_filter=True, vad_parameters={'min_silence_duration_ms': 400})
    words = []
    for seg in segments:
        for w in (seg.words or []):
            t = norm(w.word)
            if t:
                words.append({'w': t[0], 'start': w.start, 'end': w.end})
    return words, info.duration


def best_match(target, words, index):
    """在逐字稿裡找最像 target 的一段，回傳 (score, start_i, end_i)。"""
    toks = norm(target)
    n = len(toks)
    if n == 0:
        return 0, 0, 0
    starts = index.get(toks[0], [])
    if not starts:                       # 首字沒出現，就全域掃描（短句才划算）
        starts = range(0, max(1, len(words) - n)) if n <= 3 else []
    best = (0, 0, 0)
    span = max(n + 2, int(n * 1.45))
    for i in starts:
        window = [w['w'] for w in words[i:i + span]]
        if not window:
            continue
        sm = SequenceMatcher(None, toks, window, autojunk=False)
        # 只取對到的最後一個位置，避免把後面無關的話包進來
        blocks = [b for b in sm.get_matching_blocks() if b.size]
        if not blocks:
            continue
        last = blocks[-1]
        end_rel = last.b + last.size
        score = SequenceMatcher(None, toks, window[:end_rel], autojunk=False).ratio()
        if score > best[0]:
            best = (score, i, i + end_rel - 1)
    return best


def cut(audio, start, end, dst):
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-ss', f'{start:.2f}', '-to', f'{end:.2f}',
                    '-i', str(audio), '-ac', '1', '-ar', '22050', '-b:a', '64k', str(dst)], check=True)


def targets_of(lesson):
    """(item_id, 要比對的文字, 最少詞數)"""
    out = []
    for para in lesson['article']:
        for s in para:
            out.append((s['id'], s['en'], 4))
    for key in ('phrasals', 'collocations', 'idioms'):
        for p in lesson.get(key, []):
            if p.get('example'):
                out.append((p['id'], p['example'], 4))
    for v in lesson.get('vocab', []):
        out.append((v['id'], v['word'], 1))
    for q in lesson.get('questions', []):
        for i, part in enumerate(q.get('answer', [])):
            out.append((f"{q['id']}_a{i}", part['text'], 8))
    return out


def run(lesson_path, audio, out_dir, model_size=MODEL):
    lesson = json.loads(Path(lesson_path).read_text(encoding='utf-8'))
    out_dir = Path(out_dir)
    print(f'辨識中（{model_size}）…', flush=True)
    words, duration = transcribe(audio, model_size)
    print(f'  逐字稿 {len(words)} 詞 / 音檔 {duration/60:.1f} 分鐘', flush=True)

    index = {}
    for i, w in enumerate(words):
        index.setdefault(w['w'], []).append(i)

    # 1) 先算出每一句的最佳候選
    cands = []
    for item_id, text, min_words in targets_of(lesson):
        toks = norm(text)
        if len(toks) < min_words:
            continue
        score, i, j = best_match(text, words, index)
        if score >= ACCEPT and j >= i:
            cands.append({'id': item_id, 'score': score, 'i': i, 'j': j, 'n': len(toks)})

    # 2) 分數高的先佔位；同一段錄音不會同時算成兩句（例如搭配詞例句與課文句高度重疊）
    cands.sort(key=lambda c: (-c['score'], -c['n']))
    taken, accepted = [], []
    for c in cands:
        span = c['j'] - c['i'] + 1
        clash = any(min(c['j'], b) - max(c['i'], a) + 1 > 0.4 * span for a, b in taken)
        if clash:
            continue
        if c['n'] < 3:
            # 單字要「單獨被念出來」才算，夾在句子裡的不切
            before = words[c['i']]['start'] - (words[c['i'] - 1]['end'] if c['i'] else 0)
            after = (words[c['j'] + 1]['start'] if c['j'] + 1 < len(words) else duration) - words[c['j']]['end']
            if before < 0.3 or after < 0.3:
                continue
        taken.append((c['i'], c['j']))
        accepted.append(c)

    clips, low = {}, []
    got = {c['id'] for c in accepted}
    missing = [i for i, t, m in targets_of(lesson) if i not in got and len(norm(t)) >= m]
    for c in accepted:
        start = max(0, words[c['i']]['start'] - PAD_HEAD)
        end = min(duration, words[c['j']]['end'] + PAD_TAIL)
        if end - start < 0.25:
            missing.append(c['id'])
            continue
        rel = f"audio/teacher/{c['id']}.mp3"
        cut(audio, start, end, out_dir / rel)
        clips[c['id']] = {'src': rel, 'start': round(start, 2), 'end': round(end, 2),
                          'score': round(c['score'], 2), 'kind': 'teacher'}
        if c['score'] < 0.75:
            low.append(c['id'])

    lesson.setdefault('audio', {}).update(clips)
    Path(lesson_path).write_text(json.dumps(lesson, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'  對齊成功 {len(clips)} 句，其中 {len(low)} 句相似度偏低（網頁上會標記，可手動微調）')
    print(f'  沒對到 {len(missing)} 句，改用合成範讀')
    return clips, missing


if __name__ == '__main__':
    lesson_path, audio, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
    model_size = sys.argv[4] if len(sys.argv) > 4 else MODEL
    run(lesson_path, audio, out_dir, model_size)
