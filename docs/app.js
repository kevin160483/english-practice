/* 英文口說練習站 — 純靜態，所有資料在瀏覽器解密與計算，沒有後端。 */

/* ---------------- 解密 ---------------- */
const DATA = 'data';
let KEY = null, INDEX = null, LESSONS = {}, LESSON = null, LID = null;
const audioCache = new Map();

const hex2buf = h => new Uint8Array(h.match(/../g).map(b => parseInt(b, 16)));

async function deriveKey(pw, saltHex, iters) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: hex2buf(saltHex), iterations: iters, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function unseal(buf, key) {
  const d = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: d.slice(0, 12) }, key, d.slice(12));
}
async function fetchEnc(path) {
  const r = await fetch(path);   // 交給瀏覽器的一般快取，課程重做過才不會讀到舊檔
  if (!r.ok) throw new Error(path + ' ' + r.status);
  return unseal(await r.arrayBuffer(), KEY);
}

/* ---------------- 進度（存在這台裝置） ---------------- */
const LS = 'ep.progress.v1';
let state = { items: {}, sessions: {}, settings: { rate: 0.85 } };
function loadState() {
  try { const r = localStorage.getItem(LS); if (r) state = Object.assign(state, JSON.parse(r)); } catch (e) {}
}
function save() {
  state.updatedAt = Date.now();
  try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) {}
}
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00'); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };
const STEPS = [1, 2, 4, 7, 14, 30, 60];

/* 進度以 "課號:項目號" 當鍵，所以跨課複習不會撞在一起 */
function rec(k) { return state.items[k] || (state.items[k] = { n: 0, due: today(), reps: 0, star: false }); }
const got = k => state.items[k];
const isDue = k => { const r = got(k); return !r || r.due <= today(); };
function grade(k, q) {
  const r = rec(k); r.reps++; r.last = Date.now();
  if (q === 0) { r.n = 0; r.due = today(); }
  else { r.n = Math.min(STEPS.length - 1, r.n + (q === 2 ? 2 : 1)); r.due = addDays(today(), STEPS[r.n]); }
  (state.sessions[today()] || (state.sessions[today()] = { count: 0 })).count++;
  save();
}
function streak() {
  let n = 0, d = today();
  if (!state.sessions[d]) d = addDays(d, -1);
  while (state.sessions[d]) { n++; d = addDays(d, -1); }
  return n;
}

/* ---------------- 題目模型 ---------------- */
const esc = s => (s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const respHTML = t => (t || '').split(' ').map(w => w.replace(/[A-Z]{2,}/g, m => '<b>' + m + '</b>')).join(' ');
const MODULES = {
  vocab: { name: '單字發音', desc: '關鍵字重音位置' },
  article: { name: '課文朗讀', desc: '逐句跟讀與對照' },
  phrase: { name: '片語慣用語', desc: '連例句一起念' },
  qa: { name: '問答口說', desc: '用框架組織回答' },
  grammar: { name: '文法測驗', desc: '打字作答立即批改' },
};
const tag = (L, id) => L.id + ':' + id;

function itemsOf(mod, L) {
  L = L || LESSON;
  if (!L) return [];
  const wrap = o => Object.assign(o, { lid: L.id, k: tag(L, o.id), mod });
  if (mod === 'vocab') return (L.vocab || []).map(v =>
    wrap({ id: v.id, main: v.word, resp: v.resp, defn: v.def, zh: v.zh || '', speak: v.word, label: '單字' }));
  if (mod === 'article') return (L.article || []).flat().map((s, i) =>
    wrap({ id: s.id, main: s.en, resp: s.resp, zh: s.zh || '', grammar: s.grammar || '',
           speak: s.en, label: '課文 ' + (i + 1) }));
  if (mod === 'phrase') return [].concat(L.phrasals || [], L.collocations || [], L.idioms || []).map(p =>
    wrap({ id: p.id, kind: p.kind, main: p.term, defn: p.def, zh: p.zh || '', example: p.example,
           speak: p.example || p.term,
           label: { phrasal: '片語動詞', collocation: '搭配詞', idiom: '慣用語' }[p.kind] }));
  if (mod === 'qa') return (L.questions || []).map(q =>
    wrap({ id: q.id, main: q.q, q, zh: q.zh || '', tip: q.tip || '', speak: q.q, label: '問答 ' + q.n }));
  if (mod === 'grammar') return (L.grammar || []).reduce((a, s) => a.concat(
    s.items.map(i => wrap({ id: i.id, main: i.q, answerText: i.a, label: '文法 ' + s.code }))), []);
  return [];
}
const SPOKEN = ['vocab', 'article', 'phrase', 'qa'];
const dueIn = (L, mods) => [].concat(...(mods || SPOKEN).map(m => itemsOf(m, L).filter(i => isDue(i.k))));
const allLessons = () => (INDEX.lessons || []).map(l => LESSONS[l.id]).filter(Boolean);

/* ---------------- 音訊 ---------------- */
let player = new Audio(), myURL = null, micError = '';
player.preservesPitch = true;

const audioMeta = it => ((LESSONS[it.lid] || {}).audio || {})[it.id];
const refKind = it => (audioMeta(it) || {}).kind || null;

/* 同一句老師常會念不只一次，學生也會跟著念。對齊時把每一次都切下來，
   這裡讓使用者挑哪一段才是老師的聲音，選擇記在這台裝置。 */
const takeKey = (it, idSuffix) => it.lid + '/' + (idSuffix ? it.id + idSuffix : it.id);
function takesOf(it, idSuffix) {
  const meta = ((LESSONS[it.lid] || {}).audio || {})[idSuffix ? it.id + idSuffix : it.id];
  if (!meta) return [];
  return meta.takes && meta.takes.length ? meta.takes : [meta];
}
function takeIx(it, idSuffix) {
  const n = takesOf(it, idSuffix).length;
  if (n < 2) return 0;
  const v = (state.takes || {})[takeKey(it, idSuffix)] || 0;
  return Math.min(Math.max(v, 0), n - 1);
}
function setTake(it, idSuffix, ix) {
  state.takes = state.takes || {};
  state.takes[takeKey(it, idSuffix)] = ix;
  save();
}

async function audioURL(it, idSuffix) {
  const takes = takesOf(it, idSuffix);
  if (!takes.length) return null;
  const rel = takes[takeIx(it, idSuffix)].src;
  const ck = it.lid + '/' + rel;
  if (audioCache.has(ck)) return audioCache.get(ck);
  try {
    const buf = await fetchEnc(`${DATA}/${it.lid}/${rel}.enc`);
    const url = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
    audioCache.set(ck, url);
    return url;
  } catch (e) { return null; }
}
async function playRef(it, text, idSuffix) {
  stopAll();
  const url = await audioURL(it, idSuffix);
  if (url) {
    player.src = url;
    player.playbackRate = state.settings.rate;
    try { await player.play(); } catch (e) {}
    return new Promise(res => { player.onended = res; setTimeout(res, 90000); });
  }
  return speak(text);   // 最後手段：瀏覽器內建語音
}
function speak(text) {
  return new Promise(res => {
    if (!('speechSynthesis' in window) || !text) return res();
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = state.settings.rate; u.lang = 'en-US';
      u.onend = u.onerror = () => res();
      speechSynthesis.speak(u);
    } catch (e) { res(); }
  });
}
function stopAll() { try { speechSynthesis.cancel(); } catch (e) {} player.pause(); }

/* ---------------- 本機發音指標（完全離線，錄音不離開這台裝置） ---------------- */
let actx = null;
const audioCtx = () => actx || (actx = new (window.AudioContext || window.webkitAudioContext)());

async function analyse(arrayBuffer) {
  const buf = await audioCtx().decodeAudioData(arrayBuffer.slice(0));
  const ch = buf.getChannelData(0), sr = buf.sampleRate;
  const win = Math.round(sr * 0.02), frames = [];
  for (let i = 0; i + win <= ch.length; i += win) {
    let sum = 0;
    for (let j = 0; j < win; j++) { const v = ch[i + j]; sum += v * v; }
    frames.push(Math.sqrt(sum / win));
  }
  const peak = frames.reduce((a, b) => Math.max(a, b), 0);
  const thr = Math.max(peak * 0.08, 0.004);
  const voiced = frames.map(f => f > thr);
  const first = voiced.indexOf(true), last = voiced.lastIndexOf(true);
  if (first < 0) return { empty: true, total: buf.duration };
  const pauses = [];
  let run = 0;
  for (let i = first; i <= last; i++) {
    if (!voiced[i]) run++;
    else { if (run * 0.02 >= 0.25) pauses.push(run * 0.02); run = 0; }
  }
  const span = (last - first + 1) * 0.02;
  return {
    empty: false, total: buf.duration, span,
    speech: span - pauses.reduce((a, b) => a + b, 0),
    pauses, lead: first * 0.02, trail: (voiced.length - 1 - last) * 0.02,
  };
}

async function bufferOf(url) {
  const r = await fetch(url);
  return r.arrayBuffer();
}

function pct(a, b) { return Math.round((a / b - 1) * 100); }

async function compareWithReference(it, myBlob) {
  const fb = $('fb');
  if (!fb) return;
  const refUrl = await audioURL(it);
  if (!refUrl) { fb.innerHTML = '<div class="note">這一句還沒有範讀音檔，沒辦法比對長度與語速。</div>'; return; }
  fb.innerHTML = '<div class="small muted">分析中…</div>';
  try {
    const [me, ref] = await Promise.all([
      analyse(await myBlob.arrayBuffer()),
      analyse(await bufferOf(refUrl)),
    ]);
    if (me.empty) {
      fb.innerHTML = '<div class="note"><strong>幾乎沒錄到聲音。</strong>確認麥克風沒被靜音，講話時離麥克風近一點。</div>';
      return;
    }
    if (me.span < 0.8 || me.speech < 0.5 || me.span < ref.span * 0.15) {
      fb.innerHTML = '<div class="note"><strong>只錄到很短的一段。</strong>可能是麥克風沒收到，'
        + '或按下錄音後太快就按停止。再試一次：按下錄音 → 停半秒 → 念完整句 → 再停半秒才按停止。</div>';
      return;
    }
    const words = (it.speak || '').trim().split(/\s+/).filter(Boolean).length;
    const myRate = words / Math.max(me.speech, .1), refRate = words / Math.max(ref.speech, .1);
    const dRate = pct(myRate, refRate);
    const dLen = pct(me.span, ref.span);
    const rows = [];
    const tag = (d, good, fastMsg, slowMsg) =>
      Math.abs(d) <= good ? ['ok', '跟範讀差不多'] : [ 'bad', d > 0 ? fastMsg : slowMsg ];

    let [c1, m1] = tag(dRate, 12, '比範讀快，容易吞字尾', '比範讀慢，注意別一個字一個字念');
    rows.push(['語速', `${myRate.toFixed(1)} 字/秒`, c1, `範讀 ${refRate.toFixed(1)} · ${dRate >= 0 ? '+' : ''}${dRate}% ${m1}`]);

    let [c2, m2] = tag(dLen, 15, '拖得比範讀長', '比範讀短，可能有音節沒念滿');
    rows.push(['長度', `${me.span.toFixed(1)} 秒`, c2, `範讀 ${ref.span.toFixed(1)} 秒 · ${dLen >= 0 ? '+' : ''}${dLen}% ${m2}`]);

    const dp = me.pauses.length - ref.pauses.length;
    rows.push(['停頓', `${me.pauses.length} 處`, Math.abs(dp) <= 1 ? 'ok' : 'bad',
      `範讀 ${ref.pauses.length} 處 · ` + (dp > 1 ? '中間斷太多次，試著一口氣念完一個意群'
        : dp < -1 ? '幾乎沒停，可以在逗號處換氣' : '節奏接近')]);

    if (me.trail < 0.08) rows.push(['結尾', '可能被切掉', 'bad', '最後一個字還沒念完就按了停止，停止前多留半秒']);
    if (me.lead > 1.2) rows.push(['開頭', `空了 ${me.lead.toFixed(1)} 秒`, 'bad', '按下錄音後可以直接開始念']);

    fb.innerHTML = '<div class="report">' + rows.map(([k, v, cls, note]) =>
      `<div class="row2"><span class="k">${k}</span><span class="v ${cls}">${v}</span><span class="note2">${note}</span></div>`
    ).join('') + '</div>' +
      '<div class="small muted" style="margin-top:8px">這些數字是在你的瀏覽器裡算的，錄音沒有上傳。' +
      '它看得出節奏和完整度，看不出個別音發得準不準 —— 那個要靠 A/B 對照自己聽。</div>';
  } catch (e) {
    fb.innerHTML = '<div class="note">這個瀏覽器無法分析音檔（' + (e.name || e) + '），A/B 對照還是可以用。</div>';
  }
}

/* 錄音 */
let stream = null, recorder = null, chunks = [], recTimer = null;
async function startRec(onTick) {
  if (!stream) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); micError = ''; }
    catch (e) { micError = e.name || 'error'; return false; }
  }
  chunks = [];
  let opts = {};
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) { opts = { mimeType: t }; break; }
  }
  try { recorder = new MediaRecorder(stream, opts); } catch (e) { micError = 'recorder'; return false; }
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.start();
  const t0 = Date.now();
  recTimer = setInterval(() => onTick && onTick((Date.now() - t0) / 1000), 200);
  return true;
}
function stopRec() {
  return new Promise(res => {
    clearInterval(recTimer);
    if (!recorder || recorder.state === 'inactive') return res(null);
    recorder.onstop = () => res(new Blob(chunks, { type: chunks[0] ? chunks[0].type : 'audio/webm' }));
    try { recorder.stop(); } catch (e) { res(null); }
  });
}
/* 自己的錄音留在這台裝置 */
let idb = null;
function openIDB() {
  return new Promise(res => {
    if (idb) return res(idb);
    try {
      const rq = indexedDB.open('ep-rec', 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains('rec')) rq.result.createObjectStore('rec'); };
      rq.onsuccess = () => { idb = rq.result; res(idb); };
      rq.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}
async function recPut(k, v) { const d = await openIDB(); if (!d) return; try { d.transaction('rec', 'readwrite').objectStore('rec').put(v, k); } catch (e) {} }
async function recGet(k) {
  const d = await openIDB(); if (!d) return null;
  return new Promise(res => { try { const r = d.transaction('rec', 'readonly').objectStore('rec').get(k); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); } catch (e) { res(null); } });
}

/* ---------------- 畫面 ---------------- */
let tab = 'today', drill = null, phraseFilter = 'all';
const TABS = [['today', '今日'], ['vocab', '單字'], ['article', '課文'], ['phrase', '片語'], ['qa', '問答'], ['grammar', '文法'], ['audio', '音檔']];
const $ = s => document.getElementById(s);

function renderChrome() {
  $('lessonTag').innerHTML = (INDEX.lessons || []).map(l => {
    const L = LESSONS[l.id];
    const d = L ? dueIn(L).length : 0;
    return `<option value="${l.id}"${l.id === LID ? ' selected' : ''}>${l.id}${d ? ` · ${d}` : ''}</option>`;
  }).join('');
  $('tabs').innerHTML = TABS.map(([k, n]) => {
    const badge = MODULES[k] && k !== 'grammar'
      ? ` <span class="due" data-zero="${dueIn(LESSON, [k]).length ? 0 : 1}">${dueIn(LESSON, [k]).length}</span>` : '';
    return `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${n}${badge}</button>`;
  }).join('');
  $('tabs').querySelectorAll('button').forEach(b => b.onclick = () => { stopAll(); tab = b.dataset.tab; drill = null; render(); });
}
function render() {
  if (!LESSON) return;
  renderChrome();
  const v = $('view');
  if (drill) return renderDrill(v);
  if (tab === 'today') return renderToday(v);
  if (tab === 'grammar') return renderGrammar(v);
  if (tab === 'audio') return renderAudio(v);
  renderList(v, tab);
}

/* 今日隊列：每一課先把逾期最久的排前面，再以五題為一組輪流，
   這樣累積十幾課之後，每一課都會被碰到，而不是全部卡在第一課。 */
function todayQueue(perLesson, cap) {
  const overdue = i => (got(i.k) || {}).due || '9999-99-99';   // 全新的項目排在逾期的後面
  const lists = perLesson.map(x => x.due.slice().sort((a, b) => overdue(a) < overdue(b) ? -1 : overdue(a) > overdue(b) ? 1 : 0));
  const out = [];
  let moved = true;
  while (out.length < cap && moved) {
    moved = false;
    for (const list of lists) {
      const take = list.splice(0, 5);
      if (take.length) { out.push(...take); moved = true; }
      if (out.length >= cap) break;
    }
  }
  return out.slice(0, cap);
}

function renderToday(v) {
  const lessons = allLessons();
  const perLesson = lessons.map(L => ({ L, due: dueIn(L) })).filter(x => x.L);
  const dueAll = [].concat(...perLesson.map(x => x.due));
  const cap = Math.min(dueAll.length, 30);
  const totals = lessons.reduce((a, L) => {
    const items = [].concat(...['vocab', 'article', 'phrase', 'qa', 'grammar'].map(m => itemsOf(m, L)));
    a.total += items.length;
    a.done += items.filter(i => (got(i.k) || {}).reps > 0).length;
    a.teacher += Object.values(L.audio || {}).filter(x => x.kind === 'teacher').length;
    return a;
  }, { total: 0, done: 0, teacher: 0 });

  v.innerHTML = `
  <div class="hero">
    <div class="card plan">
      <span class="eyebrow">${esc(LESSON.course)} · ${lessons.length} 課</span>
      <h2>${dueAll.length ? `今天有 ${dueAll.length} 項要練` : '今天沒有到期的項目'}</h2>
      <p class="lede">${dueAll.length
        ? `跨所有課程排出來的複習，先聽老師念、再錄自己的版本、A/B 比對。約 ${Math.ceil(cap * .7)} 分鐘。`
        : '可以挑任一課加練，或回頭練標記過的難句。'}</p>
      <div class="row">
        <button class="btn primary" id="startToday"${dueAll.length ? '' : ' disabled'}>開始今日練習${cap ? `（${cap} 項）` : ''}</button>
        <button class="btn" id="startWeak">只練標記的難句</button>
      </div>
      <div class="stats">
        <div class="stat"><div class="n">${dueAll.length}</div><div class="k">今天到期</div></div>
        <div class="stat"><div class="n">${(state.sessions[today()] || {}).count || 0}</div><div class="k">今天已練</div></div>
        <div class="stat"><div class="n">${streak()}</div><div class="k">連續天數</div></div>
      </div>
      <div class="bar"><i style="width:${totals.total ? Math.round(totals.done / totals.total * 100) : 0}%"></i></div>
      <div class="small muted">全部課程進度 ${totals.done}/${totals.total} 項 · 老師原聲 ${totals.teacher} 句</div>
    </div>
    <div class="card pad">
      <span class="eyebrow">各課到期</span>
      <div class="layers" style="margin-top:10px">
        ${perLesson.map(x => `<div><span class="k mono">${x.L.id}</span><span class="v">${
          esc((x.L.title || '').replace(/^Lesson \d+\.\s*/, '')).slice(0, 28)}</span>
          <span class="mono" style="color:${x.due.length ? 'var(--accent)' : 'var(--ink-3)'}">${x.due.length}</span></div>`).join('')}
      </div>
      <div class="note">第三週開始會混到前面幾課的句子，那是刻意的 —— 隔一段時間再想起來，才是真的記住。</div>
    </div>
  </div>
  <div class="modules">
    ${Object.entries(MODULES).map(([k, m]) => {
      const items = itemsOf(k, LESSON);
      const dn = items.filter(i => (got(i.k) || {}).reps > 0).length;
      const d = k === 'grammar' ? 0 : dueIn(LESSON, [k]).length;
      return `<button class="mod" data-go="${k}">
        <div class="t">${m.name} ${d ? `<span class="chip accent">${d} 到期</span>` : ''}</div>
        <div class="d">${LID} · ${m.desc}</div><div class="bar"><i style="width:${items.length ? Math.round(dn / items.length * 100) : 0}%"></i></div>
        <div class="d mono">${dn}/${items.length}</div></button>`;
    }).join('')}
  </div>
  <div class="note">快捷鍵 <span class="kbd">空白</span> 錄音／停止 · <span class="kbd">1</span> 聽範讀 · <span class="kbd">2</span> 我的錄音 · <span class="kbd">3</span> A/B · <span class="kbd">→</span> 下一題</div>`;
  v.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { tab = b.dataset.go; render(); });
  $('startToday').onclick = () => { const q = todayQueue(perLesson, 30); if (q.length) startDrill(q); };
  $('startWeak').onclick = () => {
    const q = [].concat(...lessons.map(L => [].concat(...SPOKEN.map(m => itemsOf(m, L)))))
      .filter(i => (got(i.k) || {}).star);
    q.length ? startDrill(q) : toast('還沒有標記難句，練習時按 ★ 標記');
  };
}

function renderList(v, mod) {
  const all = itemsOf(mod, LESSON);
  const items = mod === 'phrase' && phraseFilter !== 'all' ? all.filter(i => i.kind === phraseFilter) : all;
  const dueN = items.filter(i => isDue(i.k)).length;
  v.innerHTML = `
    <div class="row" style="margin-top:18px">
      <div><span class="eyebrow">${LID} · ${MODULES[mod].name}</span><div class="small muted">${items.length} 項 · ${dueN} 項到期</div></div>
      <span class="spacer"></span>
      <button class="btn primary" id="runAll">練全部</button>
      <button class="btn" id="runDue"${dueN ? '' : ' disabled'}>只練到期</button>
    </div>
    ${mod === 'phrase' ? `<div class="seg" id="pf">${[['all', '全部'], ['phrasal', '片語動詞'], ['collocation', '搭配詞'], ['idiom', '慣用語']]
      .map(([k, n]) => `<button data-f="${k}" aria-pressed="${phraseFilter === k}">${n}</button>`).join('')}</div>` : ''}
    <div class="list">${items.map((i, ix) => {
      const r = got(i.k) || {};
      const st = !r.reps ? '未練' : (isDue(i.k) ? '待複習' : '＋' + Math.max(0, Math.round((new Date(r.due) - new Date(today())) / 864e5)) + ' 天');
      const kind = refKind(i);
      const learned = (r.reps || 0) > 0;
      return `<button class="item${learned ? ' learned' : ''}" data-ix="${ix}">
        <span class="mark">${learned ? '✓' : ''}</span>
        <span class="chip${kind === 'teacher' ? ' accent' : ''}">${kind === 'teacher' ? '♪ 老師' : i.label}</span>
        <span class="main"><span class="w">${esc(i.main).slice(0, 110)}</span><span class="s">${esc(i.zh || i.resp || i.defn || '')}</span></span>
        ${r.star ? '<span class="chip amber">★</span>' : ''}
        <span class="st ${isDue(i.k) && r.reps ? 'due' : ''}">${st}</span></button>`;
    }).join('')}</div>`;
  v.querySelectorAll('.item').forEach(b => b.onclick = () => startDrill(items, +b.dataset.ix));
  $('runAll').onclick = () => startDrill(items);
  if ($('runDue')) $('runDue').onclick = () => startDrill(items.filter(i => isDue(i.k)));
  if ($('pf')) $('pf').querySelectorAll('button').forEach(b => b.onclick = () => { phraseFilter = b.dataset.f; render(); });
}

/* ---------------- 練習 ---------------- */
function startDrill(items, ix) { if (items.length) { drill = { items, i: ix || 0, showAns: false }; myURL = null; render(); } }
const cur = () => drill.items[drill.i];

function renderDrill(v) {
  const it = cur(), r = rec(it.k), kind = refKind(it);
  const many = new Set(drill.items.map(x => x.lid)).size > 1;
  v.innerHTML = `
  <div class="card drill">
    <div class="drill-head">
      <span class="chip accent">${many ? it.lid + ' · ' : ''}${it.label}</span>
      <span class="qprog">${drill.i + 1} / ${drill.items.length}</span>
      ${kind === 'teacher' ? '<span class="chip accent">♪ 老師原聲</span>' : kind === 'tts' ? '<span class="chip">合成範讀</span>' : ''}
      <span class="spacer"></span>
      <button class="btn sm ghost" id="star">${r.star ? '★ 已標記' : '☆ 標記難句'}</button>
      <button class="btn sm ghost" id="quit">結束</button>
    </div>
    <div class="drill-body">
      <div class="say" id="sayText">${esc(it.main)}</div>
      ${it.resp ? `<div class="resp">${respHTML(esc(it.resp))}</div>` : ''}
      ${it.zh ? `<div class="zh">${esc(it.zh)}</div>` : ''}
      ${it.grammar ? `<div class="gnote"><span class="gk">文法重點</span>${esc(it.grammar)}</div>` : ''}
      ${it.tip ? `<div class="gnote"><span class="gk">回答方向</span>${esc(it.tip)}</div>` : ''}
      ${it.defn ? `<div class="defn">${esc(it.defn)}</div>` : ''}
      ${it.example ? `<div class="say" style="font-size:19px;margin-top:14px">${esc(it.example)}</div>` : ''}
      ${it.q ? `<div class="hintbox">
        <div><div class="l">Framework</div><div class="v">${esc(it.q.framework)}</div></div>
        ${it.q.phrasal ? `<div><div class="l">要用到的片語</div><div class="v">${esc(it.q.phrasal)}</div></div>` : ''}
        ${it.q.collocation ? `<div><div class="l">搭配詞</div><div class="v">${esc(it.q.collocation)}</div></div>` : ''}
        ${it.q.idiom ? `<div><div class="l">慣用語</div><div class="v">${esc(it.q.idiom)}</div></div>` : ''}</div>` : ''}
      ${it.q && drill.showAns ? `<div class="answer">${it.q.answer.map((p, i) =>
        `<div class="part"><div class="l">${esc(p.label)}</div><div class="t">${esc(p.text)}</div>
         <div><button class="btn sm" data-readpart="${i}">▶ 跟讀這段</button></div></div>`).join('')}</div>` : ''}
      ${it.q ? `<div style="margin-top:16px"><button class="btn sm" id="toggleAns">${drill.showAns ? '收起範答' : '顯示老師範答'}</button></div>` : ''}
      ${it.answerText ? `<div class="hintbox"><div><div class="l">正解</div><div class="v mono">${esc(it.answerText)}</div></div></div>` : ''}
      <div id="fb" style="margin-top:14px"></div>
    </div>
    <div class="transport">
      <select class="speed" id="speed">${[['0.6', '0.6× 慢'], ['0.75', '0.75×'], ['0.85', '0.85×'], ['1', '1× 正常']]
        .map(([x, n]) => `<option value="${x}"${String(state.settings.rate) === x ? ' selected' : ''}>${n}</option>`).join('')}</select>
      <button class="btn" id="model">▶ 聽範讀</button>
      <button class="btn rec" id="rec">● 錄音</button>
      <button class="btn" id="mine" disabled>▶ 我的錄音</button>
      <button class="btn" id="ab" disabled>⇄ A/B 對照</button>
      ${takesOf(it).length > 1 ? `<button class="btn" id="take" title="這句在錄音裡被念了不只一次，可能有一次是同學念的">
        ⇱ 換一段（${takeIx(it) + 1}/${takesOf(it).length}）</button>` : ''}
      <span class="meter" id="meter"></span>
    </div>
    <div class="rate-row">
      <span class="small muted">念完之後評一下：</span>
      <button class="btn" data-g="0">再練一次</button><button class="btn" data-g="1">還行</button>
      <button class="btn primary" data-g="2">很好</button>
      <span class="spacer"></span>
      <button class="btn ghost" id="prev">←</button><button class="btn ghost" id="next">→</button>
    </div>
  </div>`;
  $('quit').onclick = () => { stopAll(); drill = null; render(); };
  $('star').onclick = () => { r.star = !r.star; save(); render(); };
  $('speed').onchange = e => { state.settings.rate = parseFloat(e.target.value); save(); };
  $('model').onclick = () => playRef(it, it.speak);
  if ($('take')) $('take').onclick = () => {
    const n = takesOf(it).length;
    setTake(it, '', (takeIx(it) + 1) % n);
    render();
    playRef(it, it.speak);
  };
  $('prev').onclick = () => move(-1);
  $('next').onclick = () => move(1);
  v.querySelectorAll('[data-g]').forEach(b => b.onclick = () => { grade(it.k, +b.dataset.g); move(1); });
  if ($('toggleAns')) $('toggleAns').onclick = () => { drill.showAns = !drill.showAns; render(); };
  v.querySelectorAll('[data-readpart]').forEach(b => b.onclick = () =>
    playRef(it, it.q.answer[+b.dataset.readpart].text, '_a' + b.dataset.readpart));

  const meter = $('meter');
  let busy = false;
  $('rec').onclick = async () => {
    if (busy) return;
    if (recorder && recorder.state === 'recording') {
      busy = true;
      const blob = await stopRec();
      $('rec').classList.remove('on'); $('rec').textContent = '● 錄音'; meter.innerHTML = '';
      busy = false;
      if (blob && blob.size) {
        if (myURL) URL.revokeObjectURL(myURL);
        myURL = URL.createObjectURL(blob);
        recPut(it.k, blob);
        $('mine').disabled = false; $('ab').disabled = false;
        compareWithReference(it, blob);
      } else {
        $('fb').innerHTML = '<div class="note">沒有錄到東西，再試一次。</div>';
      }
      return;
    }
    busy = true;
    $('rec').textContent = '… 等麥克風';
    meter.innerHTML = '<span class="small muted">如果瀏覽器問你要不要允許麥克風，按「允許」</span>';
    const ok = await startRec(t => meter.innerHTML = `<span class="dot live"></span>${t.toFixed(1)}s`);
    busy = false;
    if (!ok) { $('rec').textContent = '● 錄音'; meter.innerHTML = ''; return micHelp(); }
    $('rec').classList.add('on'); $('rec').textContent = '■ 停止';
    $('fb').innerHTML = '<div class="small muted">念完按一次停止，會幫你比對語速和長度。</div>';
  };
  $('mine').onclick = () => { if (myURL) { stopAll(); player.src = myURL; player.playbackRate = 1; player.play().catch(() => {}); } };
  $('ab').onclick = async () => {
    await playRef(it, it.speak);
    await new Promise(r2 => setTimeout(r2, 350));
    if (myURL) { player.src = myURL; player.playbackRate = 1; player.play().catch(() => {}); }
  };
  recGet(it.k).then(b => {
    if (b && b.size) { if (myURL) URL.revokeObjectURL(myURL); myURL = URL.createObjectURL(b); $('mine').disabled = false; $('ab').disabled = false; }
  });
  if (micError) micHelp(true);
}
function move(d) {
  stopAll();
  const n = drill.i + d;
  if (n < 0) return;
  if (n >= drill.items.length) { drill = null; toast('這輪練完了'); return render(); }
  drill.i = n; drill.showAns = false; myURL = null; render();
}
function micHelp(quiet) {
  const map = {
    NotAllowedError: '瀏覽器擋住了麥克風。點網址列旁的鎖頭圖示，把麥克風改成「允許」後重新整理。',
    NotFoundError: '找不到麥克風裝置，確認耳機或內建麥克風有接上。',
    NotReadableError: '麥克風被其他程式佔用（會議軟體？），關掉後再試。'
  };
  if ($('fb')) $('fb').innerHTML = '<div class="note"><strong>錄音沒啟動：</strong>' + (map[micError] || '這個瀏覽器不支援錄音，換 Chrome 或 Safari 試試。') + '</div>';
  if (!quiet) toast('錄音沒啟動，看下方說明');
}

/* ---------------- 文法 ---------------- */
function renderGrammar(v) {
  v.innerHTML = `<div class="row" style="margin-top:18px"><div><span class="eyebrow">${LID} · 文法測驗</span>
      <div class="small muted">打完一段按「批改這段」，錯的會顯示正解</div></div></div>
    ${(LESSON.grammar || []).map(sec => {
      const done = sec.items.filter(i => ((got(tag(LESSON, i.id)) || {}).reps || 0) > 0).length;
      return `<div class="card" style="margin-top:14px">
      <div class="drill-head"><span class="chip accent">${sec.code}</span><b>${esc(sec.name)}</b>
        <span class="chip${done === sec.items.length ? ' accent' : ''}">${done}/${sec.items.length} 答對過</span>
        <span class="spacer"></span><span class="small muted">${esc(sec.instruction)}</span></div>
      ${sec.items.map(i => {
        const learned = ((got(tag(LESSON, i.id)) || {}).reps || 0) > 0;
        return `<div class="gq${learned ? ' learned' : ''}"><div class="txt"><span class="mark">${learned ? '✓' : ''}</span>${esc(i.q)}</div>
        <div class="row"><input type="text" id="in_${i.id}" autocomplete="off" spellcheck="false" placeholder="${sec.code === 'E' ? '改寫整句' : '填空'}">
        <span class="fb" id="fb_${i.id}"></span></div></div>`; }).join('')}
      <div class="rate-row"><button class="btn primary" data-check="${sec.code}">批改這段</button>
        <button class="btn" data-reveal="${sec.code}">顯示全部答案</button>
        <span class="spacer"></span><span class="small muted" id="sc_${sec.code}"></span></div></div>`; }).join('')}`;
  v.querySelectorAll('[data-check]').forEach(b => b.onclick = () => checkSection(b.dataset.check, false));
  v.querySelectorAll('[data-reveal]').forEach(b => b.onclick = () => checkSection(b.dataset.reveal, true));
  (LESSON.grammar || []).forEach(sec => sec.items.forEach(i => {
    const s = (got(tag(LESSON, i.id)) || {}).ans;
    if (s && $('in_' + i.id)) $('in_' + i.id).value = s;
  }));
}
function checkSection(code, reveal) {
  const sec = LESSON.grammar.find(s => s.code === code);
  const clean = s => (s || '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  let ok = 0;
  sec.items.forEach(i => {
    const el = $('in_' + i.id), fb = $('fb_' + i.id), val = (el.value || '').trim();
    const r = rec(tag(LESSON, i.id)); r.ans = val;
    if (clean(val) && clean(val) === clean(i.a)) { ok++; fb.className = 'fb ok'; fb.textContent = '✓'; r.reps++; r.due = addDays(today(), 7); }
    else if (reveal || val) { fb.className = 'fb no'; fb.textContent = '→ ' + i.a; }
    else fb.textContent = '';
  });
  save();
  $('sc_' + code).textContent = `${ok} / ${sec.items.length} 正確`;
  const msg = `${ok} / ${sec.items.length} 正確`;
  setTimeout(() => { render(); const el = $('sc_' + code); if (el) el.textContent = msg; }, 1200);
}

/* ---------------- 音檔狀態 ---------------- */
function renderAudio(v) {
  const all = [].concat(itemsOf('article', LESSON), itemsOf('phrase', LESSON), itemsOf('vocab', LESSON));
  const t = all.filter(i => refKind(i) === 'teacher').length;
  v.innerHTML = `<div class="row" style="margin-top:18px"><div><span class="eyebrow">${LID} · 音檔狀態</span>
      <div class="small muted">老師原聲 ${t} 句 / 合成範讀 ${all.length - t} 句。想多一點老師原聲，就把上課錄音補進 inbox 再推一次。</div></div>
      <span class="spacer"></span><button class="btn" id="exportBtn">匯出進度</button>
      <label class="btn" for="importFile">匯入進度</label><input type="file" id="importFile" accept="application/json" hidden></div>
    <div class="card marks" style="margin-top:14px">${all.map((i, ix) => {
      const kind = refKind(i), m = audioMeta(i) || {};
      const learned = ((got(i.k) || {}).reps || 0) > 0;
      return `<div class="mk${learned ? ' learned' : ''}"><span class="mark">${learned ? '✓' : ''}</span>
        <span class="chip${kind === 'teacher' ? ' accent' : ''}">${kind === 'teacher' ? '老師' : kind === 'tts' ? '合成' : '無'}</span>
        <span class="tx">${esc(i.main).slice(0, 80)}</span>
        ${m.score ? `<span class="tm">相似度 ${m.score}</span>` : ''}
        <button class="btn sm" data-play="${ix}">▶</button></div>`;
    }).join('')}</div>`;
  v.querySelectorAll('[data-play]').forEach(b => b.onclick = () => playRef(all[+b.dataset.play], ''));
  $('exportBtn').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(state)], { type: 'application/json' }));
    a.download = 'english-practice-progress.json'; a.click();
  };
  $('importFile').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then(t2 => { try { state = Object.assign(state, JSON.parse(t2)); save(); render(); toast('進度已匯入'); } catch (err) { toast('檔案讀不出來'); } });
  };
}

/* ---------------- 其他 ---------------- */
let toastTimer = null;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}
document.addEventListener('keydown', e => {
  if (!drill || /input|textarea|select/i.test(e.target.tagName)) return;
  const click = id => { const b = $(id); if (b && !b.disabled) b.click(); };
  if (e.code === 'Space') { e.preventDefault(); click('rec'); }
  else if (e.key === '1') click('model');
  else if (e.key === '2') click('mine');
  else if (e.key === '3') click('ab');
  else if (e.key === 'ArrowRight') move(1);
  else if (e.key === 'ArrowLeft') move(-1);
});

/* ---------------- 開場 ---------------- */
function selectLesson(id) {
  LID = id; LESSON = LESSONS[id];
  try { localStorage.setItem('ep.lesson', id); } catch (e) {}
  tab = 'today'; drill = null; render();
}
async function loadAll() {
  /* 全部課程都解開，今日練習才能跨課排程 */
  for (const l of (INDEX.lessons || [])) {
    try { LESSONS[l.id] = JSON.parse(new TextDecoder().decode(await fetchEnc(`${DATA}/${l.id}/lesson.enc`))); }
    catch (e) { console.warn('讀不到', l.id); }
  }
}
async function unlock(pw, remember) {
  KEY = await deriveKey(pw, INDEX.kdf.salt, INDEX.kdf.iters);
  await unseal(hex2buf(INDEX.check), KEY);         // 密碼錯就會丟例外
  if (remember) { try { localStorage.setItem('ep.pw', pw); } catch (e) {} }
  $('gate').hidden = true; $('app').hidden = false;
  await loadAll();
  const want = localStorage.getItem('ep.lesson');
  const ids = Object.keys(LESSONS);
  if (!ids.length) { $('view').innerHTML = '<div class="note" style="margin-top:20px">課程資料讀不出來，密碼可能跟建立時用的不一樣。</div>'; return; }
  selectLesson(ids.includes(want) ? want : ids[ids.length - 1]);
}
async function boot() {
  loadState();
  // 還沒有任何課程時 index.json 可能不存在，不要讓整個網站掛掉
  try {
    const r = await fetch(`${DATA}/index.json`, { cache: 'no-cache' });
    INDEX = r.ok ? await r.json() : { lessons: [] };
  } catch (e) { INDEX = { lessons: [] }; }
  if (!INDEX || !INDEX.lessons) INDEX = { lessons: [] };
  if (!INDEX.lessons || !INDEX.lessons.length) {
    $('gate').hidden = false;
    $('gate').innerHTML = '<div class="card pad">還沒有任何課程。<br><br>把講義（例如 <code>L2.docx</code>）和同名的上課錄音放進電腦上的 <code>inbox</code> 資料夾，雙擊 <code>add-lesson.bat</code>，跑完這裡就會出現。</div>';
    return;
  }
  const saved = localStorage.getItem('ep.pw');
  if (saved) { try { return await unlock(saved, false); } catch (e) { localStorage.removeItem('ep.pw'); } }
  $('gate').hidden = false;
  $('pwForm').onsubmit = async e => {
    e.preventDefault();
    $('pwErr').textContent = '';
    try { await unlock($('pw').value, $('remember').checked); }
    catch (err) { $('pwErr').textContent = '密碼不對'; }
  };
}
document.addEventListener('DOMContentLoaded', () => {
  $('lessonTag').onchange = e => selectLesson(e.target.value);
  $('lock').onclick = () => { try { localStorage.removeItem('ep.pw'); } catch (e) {} location.reload(); };
  boot();
});
