"""老師沒念到的句子，用 Piper 產生備援範讀。

Piper 是離線的神經網路語音，比瀏覽器內建的語音自然得多，但仍是合成的：
凡是老師有念的句子一律以老師原聲優先，這裡只補缺口。
"""
import json, os, subprocess, sys
from pathlib import Path

VOICE_DIR = Path(os.environ.get('PIPER_VOICE_DIR', 'voices'))
VOICE = os.environ.get('PIPER_VOICE', 'en_US-ryan-high')
BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US'
PATHS = {'en_US-ryan-high': 'ryan/high/en_US-ryan-high',
         'en_US-hfc_female-medium': 'hfc_female/medium/en_US-hfc_female-medium',
         'en_US-lessac-high': 'lessac/high/en_US-lessac-high',
         'en_US-amy-medium': 'amy/medium/en_US-amy-medium'}


def ensure_voice(name=VOICE):
    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    onnx = VOICE_DIR / f'{name}.onnx'
    if onnx.exists():
        return onnx
    rel = PATHS.get(name)
    if not rel:
        raise SystemExit(f'不認得的語音 {name}，可選：{", ".join(PATHS)}')
    print(f'下載語音 {name} …', flush=True)
    for suffix in ('.onnx', '.onnx.json'):
        subprocess.run(['curl', '-sL', '-o', str(VOICE_DIR / (name + suffix)), f'{BASE}/{rel}{suffix}'], check=True)
    return onnx


def say(text, dst, model, length_scale=1.05):
    dst.parent.mkdir(parents=True, exist_ok=True)
    wav = dst.with_suffix('.wav')
    subprocess.run(['python3', '-m', 'piper', '-m', str(model), '-f', str(wav),
                    '--length-scale', str(length_scale)],
                   input=text.encode('utf-8'), check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', str(wav),
                    '-ac', '1', '-ar', '22050', '-b:a', '48k', str(dst)], check=True)
    wav.unlink(missing_ok=True)


def items_needing_audio(lesson, with_answers=True):
    have = set(lesson.get('audio', {}))
    out = []
    for v in lesson.get('vocab', []):
        out.append((v['id'], v['word']))
    for para in lesson.get('article', []):
        for s in para:
            out.append((s['id'], s['en']))
    for key in ('phrasals', 'collocations', 'idioms'):
        for p in lesson.get(key, []):
            out.append((p['id'], p.get('example') or p['term']))
    if with_answers:
        for q in lesson.get('questions', []):
            for i, part in enumerate(q.get('answer', [])):
                out.append((f"{q['id']}_a{i}", part['text']))
    return [(i, t) for i, t in out if i not in have and t.strip()]


def run(lesson_path, out_dir, voice=VOICE, with_answers=True):
    lesson = json.loads(Path(lesson_path).read_text(encoding='utf-8'))
    model = ensure_voice(voice)
    out_dir = Path(out_dir)
    todo = items_needing_audio(lesson, with_answers)
    print(f'合成 {len(todo)} 句範讀（{voice}）…', flush=True)
    audio = lesson.setdefault('audio', {})
    for n, (item_id, text) in enumerate(todo, 1):
        rel = f'audio/tts/{item_id}.mp3'
        say(text, out_dir / rel, model)
        audio[item_id] = {'src': rel, 'kind': 'tts'}
        if n % 25 == 0:
            print(f'  {n}/{len(todo)}', flush=True)
    Path(lesson_path).write_text(json.dumps(lesson, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'  完成，共 {len(audio)} 個音檔（老師原聲 {sum(1 for a in audio.values() if a["kind"]=="teacher")}）')


if __name__ == '__main__':
    run(sys.argv[1], sys.argv[2],
        sys.argv[3] if len(sys.argv) > 3 else VOICE,
        os.environ.get('TTS_ANSWERS', '1') != '0')
