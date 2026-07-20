// Vercel Serverless Function
// 接收 { system, prompt }，读取 process.env.ZHIPU_API_KEY，
// 用 Node 内置 crypto 生成 JWT（无需任何依赖），调用智谱 glm-4-flash。
const crypto = require('crypto');

function generateToken(apiKey) {
  const [id, secret] = apiKey.split('.');
  if (!id || !secret) throw new Error('ZHIPU_API_KEY 格式应为 id.secret');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', sign_type: 'SIGN' };
  const payload = { api_key: id, exp: now + 3600, timestamp: now };
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const data = b64(header) + '.' + b64(payload);
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return data + '.' + sig;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};
  const prompt = (body.prompt || '').toString().slice(0, 4000);
  const system = (body.system || '你是一位专业的雅思口语老师，请用简洁中文回答问题。').toString().slice(0, 2000);
  if (!prompt) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: '缺少 prompt' }));
    return;
  }

  let token;
  try { token = generateToken(apiKey); }
  catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'API Key 解析失败：' + e.message }));
    return;
  }

  try {
    const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        model: 'glm-4-flash',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        stream: false
      })
    });
    const data = await r.json();
    if (!r.ok) {
      res.statusCode = r.status;
      res.end(JSON.stringify({ error: '智谱接口错误', detail: data }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(data));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: '请求智谱失败：' + e.message }));
  }
};
