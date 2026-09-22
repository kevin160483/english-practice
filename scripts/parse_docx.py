"""把上課講義 (.docx) 解析成 lesson.json。

設計成看「結構」而不是看固定行號，所以每週講義小幅變動也能吃。
無法辨識的段落會列在 warnings，不會讓整個流程失敗。
"""
import json, re, sys
from pathlib import Path
from docx import Document

DASH = re.compile(r'\s+[—–-]\s+')
RESP_TOKEN = re.compile(r'[A-Z]{2,}')


def paras(path):
    d = Document(path)
    out = []
    for p in d.paragraphs:
        t = p.text.strip()
        if t:
            out.append((p.style.name or 'normal', t))
    return out


def is_heading(style, level=None):
    if not style.startswith('Heading'):
        return False
    return True if level is None else style.endswith(str(level))


def split_sentences(text):
    parts = re.split(r'(?<=[.!?])\s+(?=[A-Za-z])', text.strip())
    return [p.strip() for p in parts if p.strip()]


def resp_ratio(text):
    """拼音版段落的特徵：大量全大寫音節 + 連字號。"""
    words = text.split()
    if not words:
        return 0
    hits = sum(1 for w in words if RESP_TOKEN.search(w) and '-' in w)
    return hits / len(words)


def term_def(text):
    """'hook up — to connect...' → (term, def, example)"""
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    head = lines[0]
    example = ''
    for l in lines[1:]:
        if l.lower().startswith('example:'):
            example = l.split(':', 1)[1].strip()
    m = DASH.split(head, maxsplit=1)
    if len(m) == 2:
        return m[0].strip(), m[1].strip(), example
    return head, '', example


def labeled(text):
    """'Framework: ...\n Point: ...' → dict"""
    out = {}
    for l in [x.strip() for x in text.split('\n') if x.strip()]:
        if ':' in l:
            k, v = l.split(':', 1)
            k = k.strip().lower().replace('recommended ', '')
            if len(k) < 30:
                out[k] = v.strip()
    return out


def sections(ps):
    """切成 [(heading_style, heading_text, [body paragraphs], h1_context)]"""
    out, cur, h1 = [], None, ''
    for style, text in ps:
        if is_heading(style, 1):
            h1 = text
        if is_heading(style):
            cur = [style, text, [], h1]
            out.append(cur)
        elif cur:
            cur[2].append(text)
        else:
            out.append(['normal', '', [text], h1])
            cur = out[-1]
    return out


def parse(path, lesson_id=None):
    ps = paras(path)
    secs = sections(ps)
    warn = []

    course = next((t for s, t in ps if is_heading(s, 1)), 'English Speaking')
    title = next((t for s, t in ps if s == 'normal' and re.match(r'^Lesson\s+\d+', t)), '')
    if not title:
        title = next((h for st, h, _, _h1 in secs if st.startswith('Heading 2')), 'Lesson')
    lid = lesson_id or (re.search(r'Lesson\s+(\d+)', title).group(1) if re.search(r'Lesson\s+(\d+)', title) else 'X')
    lid = 'L' + str(lid).lstrip('L')

    lesson = {'id': lid, 'course': course, 'title': title,
              'vocab': [], 'article': [], 'phrasals': [], 'collocations': [],
              'idioms': [], 'questions': [], 'grammar': []}

    # ---- 單字 ----
    for st, head, body, h1 in secs:
        if re.search(r'phonics|vocabulary', head, re.I):
            for b in body:
                t, d, _ = term_def(b)
                parts = DASH.split(b.replace('\n', ' '), maxsplit=2)
                if len(parts) == 3:
                    lesson['vocab'].append({'id': f'v{len(lesson["vocab"])+1}',
                                            'word': parts[0].strip(), 'resp': parts[1].strip(),
                                            'def': parts[2].strip()})
                elif t:
                    lesson['vocab'].append({'id': f'v{len(lesson["vocab"])+1}',
                                            'word': t, 'resp': '', 'def': d})
            break

    # ---- 課文：找拼音段落與英文段落配對 ----
    SKIP = r'phonics|vocabulary|phrasal|colloc|idiom|discussion|grammar|answer key|exercise'
    resp_paras, en_paras = [], []
    for st, head, body, h1 in secs:
        if re.search(SKIP, head or '', re.I) or re.search(SKIP, h1 or '', re.I):
            continue
        if re.match(r'^\d+\.', head or ''):
            continue
        for b in body:
            if len(b.split()) < 12 or '\n' in b or re.match(r'^\s*\w[\w \-]{0,24}:\s', b):
                continue
            (resp_paras if resp_ratio(b) > .3 else en_paras).append(b)
    for i, en in enumerate(en_paras):
        en_s = split_sentences(en)
        rs_s = split_sentences(resp_paras[i]) if i < len(resp_paras) else []
        if rs_s and len(rs_s) != len(en_s):
            warn.append(f'課文第 {i+1} 段：英文 {len(en_s)} 句、拼音 {len(rs_s)} 句，拼音改為整段對照')
            rs_s = []
        lesson['article'].append([
            {'id': f'a{i}_{k}', 'en': s, 'resp': rs_s[k] if k < len(rs_s) else ''}
            for k, s in enumerate(en_s)])
    if not lesson['article']:
        warn.append('找不到課文段落')

    # ---- 片語 / 搭配詞 / 慣用語 ----
    for key, pat, pre in (('phrasals', r'phrasal', 'p'), ('collocations', r'colloc', 'c'), ('idioms', r'idiom', 'i')):
        for st, head, body, h1 in secs:
            if re.search(pat, head, re.I) and not re.search(r'discussion|answer', head, re.I):
                for b in body:
                    t, d, ex = term_def(b)
                    if t:
                        lesson[key].append({'id': f'{pre}{len(lesson[key])+1}', 'kind': key[:-1] if key != 'phrasals' else 'phrasal',
                                            'term': t, 'def': d, 'example': ex})
                break

    # ---- 問答：第一輪是題目，第二輪是範答 ----
    qsecs = [(h, b) for st, h, b, _h1 in secs if st.startswith('Heading 2') and re.match(r'^\d+\.', h)]
    bucket = {}
    for head, body in qsecs:
        n = int(re.match(r'^(\d+)\.', head).group(1))
        text = '\n'.join(body)
        meta = labeled(text)
        entry = bucket.setdefault(n, {'q': head.split('.', 1)[1].strip(), 'hint': {}, 'answer': []})
        parts = [(k, v) for k, v in meta.items() if k not in ('framework',)]
        # 題目區塊帶 Phrasal Verb / Collocation / Idiom；範答區塊只有框架各段落
        looks_like_answer = (not any(k in meta for k in ('phrasal verb', 'collocation', 'idiom'))
                             and len(parts) >= 2)
        if looks_like_answer:
            entry['answer'] = [{'label': k.title(), 'text': v} for k, v in parts]
            entry.setdefault('framework', meta.get('framework', ''))
        else:
            entry['framework'] = meta.get('framework', entry.get('framework', ''))
            entry['hint'] = {'phrasal': meta.get('phrasal verb', ''), 'collocation': meta.get('collocation', ''),
                             'idiom': meta.get('idiom', '')}
    for n in sorted(bucket):
        e = bucket[n]
        lesson['questions'].append({'id': f'q{n}', 'n': n, 'q': e['q'], 'framework': e.get('framework', ''),
                                    'phrasal': e['hint'].get('phrasal', ''), 'collocation': e['hint'].get('collocation', ''),
                                    'idiom': e['hint'].get('idiom', ''), 'answer': e['answer']})

    # ---- 文法：練習區與解答區用字母配對 ----
    ex, key = {}, {}
    in_key = False
    for st, head, body, h1 in secs:
        if is_heading(st, 1):
            in_key = bool(re.search(r'answer key', head, re.I))
            continue
        m = re.match(r'^([A-E])\.\s*(.+)', head)
        if not m:
            continue
        code, name = m.group(1), m.group(2).strip()
        if in_key:
            key[code] = body
        else:
            instruction = body[0] if body and re.search(r'fill in|rewrite|correct|each ', body[0], re.I) else ''
            items = body[1:] if instruction else body
            ex[code] = (name, instruction, items)
    for code in sorted(ex):
        name, instruction, items = ex[code]
        answers = key.get(code, [])
        if answers and len(answers) != len(items):
            warn.append(f'文法 {code}：題目 {len(items)} 題、答案 {len(answers)} 個，超出的題目沒有答案')
        lesson['grammar'].append({'code': code, 'name': name, 'instruction': instruction,
                                  'items': [{'id': f'g{code}{i+1}', 'q': q, 'a': answers[i] if i < len(answers) else ''}
                                            for i, q in enumerate(items)]})

    counts = {'vocab': len(lesson['vocab']), 'article': sum(len(p) for p in lesson['article']),
              'phrasals': len(lesson['phrasals']), 'collocations': len(lesson['collocations']),
              'idioms': len(lesson['idioms']), 'questions': len(lesson['questions']),
              'grammar': sum(len(s['items']) for s in lesson['grammar'])}
    return lesson, counts, warn


if __name__ == '__main__':
    src = Path(sys.argv[1])
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else Path('lesson.json')
    lesson, counts, warn = parse(src, sys.argv[3] if len(sys.argv) > 3 else None)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(lesson, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'{lesson["id"]}  {counts}')
    for w in warn:
        print('  ! ' + w)
