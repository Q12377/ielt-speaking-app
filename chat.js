// chat.js — 纯浏览器端 JS（无任何 Node.js 语法：无 require / process / Buffer）
// 负责：界面交互、录音(MediaRecorder)、本地存储(IndexedDB)、调用后端 /api/evaluate 评分。

/* ============ 工具 ============ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function getArr(k) { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } }
function setArr(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

// Blob → Base64（浏览器用 FileReader，绝不用 Buffer）
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result); // data:audio/webm;base64,xxxx
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

/* ============ 状态 / 离线指示 ============ */
const statusEl = document.getElementById('status');
function setStatus(t, off) { statusEl.textContent = t; statusEl.classList.toggle('off', !!off); }
window.addEventListener('online', () => setStatus('在线 · 就绪'));
window.addEventListener('offline', () => setStatus('离线 · 仅本地功能可用', true));
if (!navigator.onLine) setStatus('离线 · 仅本地功能可用', true);

/* ============ 标签页切换 ============ */
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.tab).classList.add('active');
  });
});

/* ============ 通用 API 调用（不背单词 / 轻听英语） ============ */
async function callAPI(system, prompt) {
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, prompt })
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/* ============ 实战演练 ============ */
const TOPICS = [
  '描述一个曾经激励过你的人。', '描述一本你读过并喜欢的书。', '描述一个你去过的、非常拥挤的地方。',
  '描述一项你学会的、很难的技能。', '描述一件你觉得很有用的科技产品。', '描述一次令你难忘的旅行。',
  '描述一部你最近看过的电影。', '描述一次你帮助别人的经历。', '描述一个你想养成的好习惯。',
  '描述你收到过的一条好消息。', '描述一个你经常使用的网站或App。', '描述你们国家的一个传统节日庆祝活动。',
  '描述一个你欣赏其才华的人。', '描述一次你面对的挑战性经历。', '描述一件对你很重要的物品。',
  '描述一次你迟到的经历。', '描述一首你喜欢听的歌或一段音乐。', '描述一次你和别人一起享用的美食。',
  '描述一个你想要实现的目标。', '描述一个你表现得很有礼貌的场合。'
];
const timerEl = document.getElementById('timer');
const phaseEl = document.getElementById('phaseLabel');
let phase = 'idle', timer = null, remain = 0, currentTopic = '', prepTotal = 60, ansTotal = 120;
let lastBlob = null; // 最近一次录音的 Blob，供“开始评分”使用

function fmt(s) { const m = String(Math.floor(s / 60)).padStart(2, '0'); const ss = String(s % 60).padStart(2, '0'); return m + ':' + ss; }
function updateTimer() { timerEl.textContent = fmt(remain); }
function beep() {
  try {
    const c = new (window.AudioContext || window.webkitAudioContext)();
    const o = c.createOscillator(); const g = c.createGain();
    o.connect(g); g.connect(c.destination); o.frequency.value = 880; g.gain.value = 0.1;
    o.start(); setTimeout(() => { o.stop(); c.close(); }, 300);
  } catch (e) {}
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

function drawTopic() {
  currentTopic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  document.getElementById('topicText').textContent = currentTopic;
  phase = 'idle'; stopTimer(); remain = prepTotal; updateTimer();
  phaseEl.textContent = '未开始';
  document.getElementById('startBtn').disabled = false;
  document.getElementById('recBtn').disabled = true;
  document.getElementById('stopRecBtn').disabled = true;
  hideEvalButton();
}
function startPractice() {
  if (!currentTopic) { alert('请先抽取话题'); return; }
  phase = 'prep'; remain = prepTotal; updateTimer(); phaseEl.textContent = '准备中…';
  document.getElementById('startBtn').disabled = true;
  timer = setInterval(() => {
    remain--; updateTimer();
    if (remain <= 0) {
      if (phase === 'prep') { phase = 'answer'; remain = ansTotal; phaseEl.textContent = '答题中（可开始录音）'; beep(); document.getElementById('recBtn').disabled = false; }
      else { stopTimer(); phase = 'done'; phaseEl.textContent = '演练结束'; beep(); document.getElementById('recBtn').disabled = true; document.getElementById('stopRecBtn').disabled = true; }
    }
  }, 1000);
}
document.getElementById('drawBtn').addEventListener('click', drawTopic);
document.getElementById('startBtn').addEventListener('click', startPractice);
drawTopic();

/* ============ 录音（MediaRecorder + IndexedDB 本地存储） ============ */
const DB = 'ielts_rec', STORE = 'recs';
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
let mr = null, chunks = [], recStream = null, mime = '';
async function startRec() {
  try {
    recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
    mr = new MediaRecorder(recStream, mime ? { type: mime } : undefined);
    chunks = [];
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = async () => {
      const blob = new Blob(chunks, { type: mime || 'audio/webm' });
      lastBlob = blob; // 供评分使用
      const db = await openDB();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add({ blob, topic: currentTopic, ts: Date.now() });
      tx.oncomplete = () => { recStream.getTracks().forEach(t => t.stop()); loadRecs(); };
      // 录音结束 → 显示“开始评分”按钮
      showEvalButton();
    };
    mr.start();
    document.getElementById('recBtn').disabled = true;
    document.getElementById('stopRecBtn').disabled = false;
    setStatus('录音中…');
  } catch (e) { alert('无法访问麦克风：' + e.message); }
}
function stopRec() {
  if (mr && mr.state !== 'inactive') { mr.stop(); document.getElementById('recBtn').disabled = false; document.getElementById('stopRecBtn').disabled = true; setStatus('录音已保存本机'); }
}
document.getElementById('recBtn').addEventListener('click', startRec);
document.getElementById('stopRecBtn').addEventListener('click', stopRec);

async function loadRecs() {
  const box = document.getElementById('recList'); box.innerHTML = '';
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  const req = tx.objectStore(STORE).getAll();
  req.onsuccess = () => {
    const arr = (req.result || []).sort((a, b) => b.ts - a.ts);
    if (!arr.length) { box.innerHTML = '<div class="hint">暂无录音</div>'; return; }
    arr.forEach(r => {
      const url = URL.createObjectURL(r.blob);
      const d = document.createElement('div'); d.className = 'rec';
      const t = new Date(r.ts);
      d.innerHTML = '<div class="hint">' + t.toLocaleString() + ' · ' + (r.topic || '未命名话题') + '</div>';
      const a = document.createElement('audio'); a.controls = true; a.src = url; d.appendChild(a);
      box.appendChild(d);
    });
  };
}
loadRecs();

/* ============ 开始评分按钮（录音结束后显示并绑定） ============ */
const evalBtn = document.getElementById('evalBtn');
function showEvalButton() {
  evalBtn.style.display = 'block';
  evalBtn.disabled = false;
  evalBtn.textContent = '🚀 开始评分';
}
function hideEvalButton() {
  evalBtn.style.display = 'none';
  evalBtn.disabled = true;
}
evalBtn.addEventListener('click', () => {
  if (lastBlob) startEvaluation(lastBlob);
  else alert('请先完成一次录音');
});

/* ============ 核心：startEvaluation(audioBlob) ============ */
async function startEvaluation(audioBlob) {
  const box = document.getElementById('evalResult');
  box.innerHTML = '<div class="hint">正在分析…（转写并评分中，请稍候）</div>';
  evalBtn.disabled = true; evalBtn.textContent = '分析中…';
  setStatus('AI 评估中…');
  try {
    // 1) Blob → Base64
    const audio = await blobToBase64(audioBlob);
    // 2) POST 到后端 /api/evaluate
    const r = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio, topic: currentTopic || '' })
    });
    const data = await r.json();
    // 3) 渲染结果
    if (!r.ok || data.error) {
      box.innerHTML = '<div class="hint">分析失败：' + escapeHtml(data.error || ('HTTP ' + r.status)) + '</div>';
      setStatus('评估失败', true);
    } else {
      renderEval(data);
      setStatus('评估完成');
    }
  } catch (e) {
    box.innerHTML = '<div class="hint">分析失败：' + escapeHtml(e.message) + '</div>';
    setStatus('评估失败', true);
  } finally {
    evalBtn.disabled = false; evalBtn.textContent = '🚀 重新评分';
  }
}

function scoreChip(label, val) {
  return '<div style="flex:1;min-width:90px;text-align:center;background:#eef3ec;border-radius:10px;padding:8px;margin:4px;">'
    + '<div style="font-size:22px;font-weight:800;color:#3a6347;">' + (val == null ? '-' : val) + '</div>'
    + '<div class="hint" style="margin:0;">' + label + '</div></div>';
}
function renderEval(d) {
  const box = document.getElementById('evalResult');
  if (d.raw) { box.innerHTML = '<div class="item"><p>' + escapeHtml(d.raw) + '</p></div>'; return; }
  const s = d.scores || {};
  let html = '<div class="item"><h3>AI 评分报告</h3>';
  html += '<div class="row" style="display:flex;gap:8px;flex-wrap:wrap;">';
  html += scoreChip('流利度', s.fluency);
  html += scoreChip('词汇', s.vocabulary);
  html += scoreChip('语法', s.grammar);
  html += scoreChip('发音', s.pronunciation);
  html += '</div>';
  if (d.overall != null) html += '<p style="margin-top:8px;"><b>综合得分：' + d.overall + '</b></p>';
  if (d.transcript) html += '<p><b>转写文本：</b>' + escapeHtml(d.transcript) + '</p>';
  if (d.suggestions && d.suggestions.length) {
    html += '<p><b>改进建议：</b></p><ul style="margin:4px 0;padding-left:20px;">'
      + d.suggestions.map(x => '<li>' + escapeHtml(x) + '</li>').join('') + '</ul>';
  }
  if (d.betterExpressions && d.betterExpressions.length) {
    html += '<p><b>更地道的表达：</b></p><ul style="margin:4px 0;padding-left:20px;">'
      + d.betterExpressions.map(x => '<li>' + escapeHtml(x) + '</li>').join('') + '</ul>';
  }
  html += '</div>';
  box.innerHTML = html;
}

/* ============ 不背单词 ============ */
document.getElementById('vocabGen').addEventListener('click', async () => {
  const w = document.getElementById('vocabInput').value.trim(); if (!w) { alert('请输入生词'); return; }
  setStatus('生成中…');
  const sys = '你是雅思词汇助手，请像“不背单词”App一样，用中文简明讲解该英文单词/短语：先给音标、词性、中文释义，再给2个例句（附中文翻译），最后给常见搭配。总字数控制在200字以内。';
  const data = await callAPI(sys, w);
  if (data && data.choices && data.choices[0]) {
    const arr = getArr('ielts_vocab'); arr.unshift({ w, text: data.choices[0].message.content, ts: Date.now() }); setArr('ielts_vocab', arr);
    document.getElementById('vocabInput').value = ''; renderVocab(); setStatus('完成');
  } else { setStatus('生成失败，请检查网络或 ZHIPU_API_KEY', true); }
});
function renderVocab() {
  const box = document.getElementById('vocabList'); const arr = getArr('ielts_vocab'); box.innerHTML = '';
  arr.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'item';
    d.innerHTML = '<button class="del" data-i="' + i + '">删除</button><h3>' + escapeHtml(it.w) + '</h3><p>' + escapeHtml(it.text) + '</p>';
    box.appendChild(d);
  });
  box.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => { const a = getArr('ielts_vocab'); a.splice(+b.dataset.i, 1); setArr('ielts_vocab', a); renderVocab(); }));
}
renderVocab();

/* ============ 轻听英语 ============ */
document.getElementById('listenGen').addEventListener('click', async () => {
  const t = document.getElementById('listenInput').value.trim(); if (!t) { alert('请粘贴听力原文'); return; }
  setStatus('生成中…');
  const sys = '你是一位雅思听力/口语老师。请根据下面的英文听力原文，设计一段“复述训练”任务：用中文列出3-5个必须复述的关键信息点，并提出2个引导性问题，帮助学生用自己的话复述。总字数控制在200字以内。';
  const data = await callAPI(sys, t);
  if (data && data.choices && data.choices[0]) {
    const arr = getArr('ielts_listen'); arr.unshift({ t, text: data.choices[0].message.content, ts: Date.now() }); setArr('ielts_listen', arr);
    document.getElementById('listenInput').value = ''; renderListen(); setStatus('完成');
  } else { setStatus('生成失败，请检查网络或 ZHIPU_API_KEY', true); }
});
function renderListen() {
  const box = document.getElementById('listenList'); const arr = getArr('ielts_listen'); box.innerHTML = '';
  arr.forEach((it, i) => {
    const d = document.createElement('div'); d.className = 'item';
    const prev = it.t.length > 120 ? it.t.slice(0, 120) + '…' : it.t;
    d.innerHTML = '<button class="del" data-i="' + i + '">删除</button><h3>复述任务 #' + (arr.length - i) + '</h3><p>' + escapeHtml(it.text) + '</p><div class="hint">原文：' + escapeHtml(prev) + '</div>';
    box.appendChild(d);
  });
  box.querySelectorAll('.del').forEach(b => b.addEventListener('click', () => { const a = getArr('ielts_listen'); a.splice(+b.dataset.i, 1); setArr('ielts_listen', a); renderListen(); }));
}
renderListen();

/* ============ Service Worker 注册（PWA 离线） ============ */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}
