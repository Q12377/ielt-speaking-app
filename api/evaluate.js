// api/evaluate.js — Vercel Serverless Function (Node.js)
// 接收前端 Base64 音频 → 步骤A 语音转文字 → 步骤B 智谱 GLM 评分
// 纯 Node 后端：使用 require / process.env / Buffer，绝不含有任何浏览器代码。
const crypto = require('crypto');

// 用 Node 内置 crypto 生成智谱 JWT（无需任何第三方依赖）
function generateToken(apiKey) {
  const [id, secret] = apiKey.split('.');
  if (!id || !secret) throw new Error('ZHIPU_API_KEY 格式应为 id.secret');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', sign_type: 'SIGN' };
  const payload = { api_key: id, exp: now + 3600, timestamp: now };
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = b64(header) + '.' + b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + sig;
}

// 统一设置 CORS，允许前端跨域访问
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// 步骤A-1：智谱 glm-4-audio 多模态转写（需账号已开通音频模型）
async function transcribeWithZhipu(audioDataUrl, token) {
  const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({
      model: 'glm-4-audio',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '请将这段音频中的英文语音准确转写为文本，只输出转写结果，不要额外解释。' },
          { type: 'audio_url', audio_url: { url: audioDataUrl } }
        ]
      }]
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error('glm-4-audio 错误: ' + JSON.stringify(data));
  return (data.choices && data.choices[0].message.content || '').trim();
}

// 步骤A-2：OpenAI Whisper 兜底（可选，在 Vercel 配置 OPENAI_API_KEY 后启用）
async function transcribeWithWhisper(audioBuffer) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), 'audio.webm');
  form.append('model', 'whisper-1');
  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key },
    body: form
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Whisper 错误: ' + JSON.stringify(data));
  return (data.text || '').trim();
}

// 从模型文本中安全提取 JSON
function extractJSON(s) {
  try { const m = s.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
  catch (e) { return null; }
}

module.exports = async (req, res) => {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');

  // 预检请求
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: '仅支持 POST' }));
    return;
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: '服务端未配置 ZHIPU_API_KEY' }));
    return;
  }

  // 解析请求体（Vercel 默认已解析 JSON，兼容字符串情况）
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const audio = body.audio;                 // 前端传来的 data URL: data:audio/webm;base64,xxxx
  const topic = (body.topic || '').toString().slice(0, 500);
  if (!audio) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: '缺少 audio（Base64 音频）' }));
    return;
  }

  // 生成智谱访问令牌
  let token;
  try { token = generateToken(apiKey); }
  catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'API Key 解析失败：' + e.message }));
    return;
  }

  // Node 原生：Base64 → Buffer（二进制数据），可用于 Whisper 等需要文件的接口
  const base64 = audio.includes(',') ? audio.split(',')[1] : audio;
  const audioBuffer = Buffer.from(base64, 'base64');

  // ===== 步骤A：语音转文字 =====
  let transcript = '';
  try {
    transcript = await transcribeWithZhipu(audio, token);
  } catch (e) {
    // 智谱音频模型不可用 → 尝试 Whisper → 仍失败则模拟（保证流程可演示）
    try { const w = await transcribeWithWhisper(audioBuffer); if (w) transcript = w; } catch (_) { /* ignore */ }
    if (!transcript) {
      transcript = '[模拟转写] 未配置可用的语音识别（请确认 ZHIPU 已开通 glm-4-audio，或在 Vercel 配置 OPENAI_API_KEY 启用 Whisper）。原音频已成功上传，仅转写步骤被模拟。';
    }
  }

  // ===== 步骤B：雅思考官评分 =====
  const system = `你是一位严谨的雅思考官（IELTS Speaking Examiner）。
请根据考生录音的转写文本，从以下四个维度评分（每项 0-9 分，允许 .5）：
1. fluency（流利度与连贯性）
2. vocabulary（词汇多样性与准确性）
3. grammar（语法范围与准确性）
4. pronunciation（发音；若仅基于文本无法判断，请给 7 分并在 suggestions 中注明"发音需线下由真人确认"）

要求：
- 严格只输出一个 JSON 对象，不要包含 Markdown 代码块标记或任何额外文字。
- JSON 结构如下：
{
  "scores": {"fluency": 7, "vocabulary": 6.5, "grammar": 6, "pronunciation": 7},
  "overall": 6.5,
  "suggestions": ["针对语法：...", "针对词汇：...", "针对流利度：..."],
  "betterExpressions": ["原表达：'I very like it' → 更地道：'I really like it' / 'I am very fond of it'"]
}
- suggestions 至少 3 条，具体、可操作；betterExpressions 给出 2-4 个真实修改范例。
- 若文本本身较优秀、无明显错误，请指出可进一步提升的更高级表达。`;

  const user = `本次口语话题：${topic || '（未提供）'}\n\n考生录音转写文本：\n${transcript}\n\n请按系统要求评分并严格返回 JSON。`;

  try {
    const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        model: 'glm-4-flash', // 如需更高质量可改为 'glm-4' 或 'glm-3-turbo'
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user }
        ],
        temperature: 0.4,
        stream: false
      })
    });
    const data = await r.json();
    if (!r.ok) {
      res.statusCode = r.status;
      res.end(JSON.stringify({ error: '智谱评分接口错误', detail: data }));
      return;
    }
    const content = (data.choices && data.choices[0].message.content) || '';
    const parsed = extractJSON(content);
    const result = parsed || { raw: content };
    result.transcript = transcript;
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: '评分请求失败：' + e.message }));
  }
};
