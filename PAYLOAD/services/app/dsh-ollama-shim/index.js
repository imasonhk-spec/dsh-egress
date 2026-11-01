'use strict';
const http = require('http');

const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 18100; // Huiwen Agron gateway; native Ollama remains at 11439.
// 需要常驻的模型：注入 keep_alive:-1。
// 为什么必须在这里做：ollama 的 OpenAI 兼容端点(/v1/chat/completions)不会沿用
// 后端的 OLLAMA_KEEP_ALIVE，而是每次请求把该模型的到期时间重置为默认 5 分钟
// (2026-10-07 实测：容器 OLLAMA_KEEP_ALIVE=-1，/api/chat 得到 -1，但 /v1 得到 +5min)。
// 而知识库插件与 DSH 本地模型 provider 走的正是 /v1，所以只在后端设 -1 不够。
// shim 是所有本地模型流量的统一入口，在此补齐。
// 逗号分隔；设 SHIM_KEEP_ALIVE_MODELS= 空串可关闭该行为。
const KEEP_ALIVE_MODELS = (process.env.SHIM_KEEP_ALIVE_MODELS === undefined
  ? 'huiwen-luna:latest'
  : process.env.SHIM_KEEP_ALIVE_MODELS)
  .split(',').map((s) => s.trim()).filter(Boolean);
// 非白名单模型的空闲保留时长（ollama 默认即 5m，这里显式写出以压过容器级
// OLLAMA_KEEP_ALIVE=-1）。设为 0 表示用完立即卸载；可用 SHIM_IDLE_KEEP_ALIVE 覆盖。
const IDLE_KEEP_ALIVE = process.env.SHIM_IDLE_KEEP_ALIVE === undefined
  ? '5m'
  : process.env.SHIM_IDLE_KEEP_ALIVE;
// 这些路径都接受 ollama 的 keep_alive 字段（OpenAI 兼容层会读该扩展字段）。
const LLM_PATHS = new Set(['/v1/chat/completions', '/v1/completions', '/api/chat', '/api/generate']);
// 监听规格：'host:port'，逗号分隔。默认保持历史行为（仅 127.0.0.1:11435）；
// 生产单元用 SHIM_LISTEN 追加 0.0.0.0:11434，使 11434 成为本地模型统一入口。
const LISTEN_SPECS = (process.env.SHIM_LISTEN || '127.0.0.1:11435')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((spec) => {
    const i = spec.lastIndexOf(':');
    return i < 0
      ? { host: '127.0.0.1', port: parseInt(spec, 10) }
      : { host: spec.slice(0, i) || '127.0.0.1', port: parseInt(spec.slice(i + 1), 10) };
  })
  .filter((x) => Number.isInteger(x.port) && x.port > 0 && x.port < 65536);

function normalizeParameters(p) {
  if (!p || typeof p !== 'object') return p;
  const required = new Set();
  if (typeof p.required === 'boolean') {
    if (p.required && p.properties && typeof p.properties === 'object') {
      for (const k of Object.keys(p.properties)) required.add(k);
    }
    delete p.required;
  } else if (Array.isArray(p.required)) {
    for (const x of p.required) if (typeof x === 'string') required.add(x);
  }
  if (p.properties && typeof p.properties === 'object') {
    for (const [k, prop] of Object.entries(p.properties)) {
      if (prop && typeof prop === 'object' && typeof prop.required === 'boolean') {
        if (prop.required) required.add(k);
        delete prop.required;
      }
    }
  }
  p.required = Array.from(required);
  return p;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return tools;
  let changed = false;
  for (const t of tools) {
    if (t && t.function) {
      const before = JSON.stringify(t.function.parameters);
      normalizeParameters(t.function.parameters);
      if (JSON.stringify(t.function.parameters) !== before) changed = true;
    }
  }
  return changed;
}

function handleRequest(req, res) {
  const urlPath = (req.url || '').split('?')[0];
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = Buffer.concat(chunks);
    let rewrote = false;
    if (req.method === 'POST' && LLM_PATHS.has(urlPath)) {
      try {
        const json = JSON.parse(body.toString('utf8'));
        if (json && Array.isArray(json.tools) && normalizeTools(json.tools)) rewrote = true;
        // 常驻：仅对清单内模型、且调用方未显式指定 keep_alive 时注入，不覆盖调用方选择。
        // 非常驻：显式回落为有限 keep_alive。否则【容器级】OLLAMA_KEEP_ALIVE=-1 会把
        // 按需模型（如 huiwen-max）也钉成永久 —— 2026-10-08 实测：走 /v1 拉起 max 后
        // /api/ps 的 expires_at=2319-01-17（永久），与「其它模型按需、不用时不加载」冲突。
        if (json && json.model && json.keep_alive == null) {
          json.keep_alive = KEEP_ALIVE_MODELS.includes(json.model) ? -1 : IDLE_KEEP_ALIVE;
          rewrote = true;
          process.stderr.write('[shim] keep_alive=' + json.keep_alive + ' injected for '
            + json.model + ' on ' + urlPath + '\n');
        }
        if (json && (json.model === 'occamy-1.0-q5:latest' || json.model === 'huiwen-lm:latest')) {
          // Ollama otherwise enables a potentially long thinking phase by default.
          // Keep explicit caller choices; disable it only when unspecified.
          if (urlPath === '/v1/chat/completions' && json.reasoning_effort == null) {
            json.reasoning_effort = 'none';
            rewrote = true;
          }
          if (urlPath === '/api/chat' && json.think == null) {
            json.think = false;
            rewrote = true;
          }
          const messages = Array.isArray(json.messages) ? json.messages : [];
          const chars = messages.reduce((n, m) => n + JSON.stringify(m).length, 0);
          process.stderr.write('[shim] occamy request messages=' + messages.length
            + ' messageChars=' + chars + ' tools=' + (json.tools || []).length
            + ' stream=' + Boolean(json.stream) + '\n');
        }
        if (rewrote) body = Buffer.from(JSON.stringify(json), 'utf8');
      } catch (e) {
        // 非 JSON body，原样转发
      }
    }
    const headers = Object.assign({}, req.headers);
    delete headers['transfer-encoding'];
    headers['host'] = TARGET_HOST + ':' + TARGET_PORT;
    headers['content-length'] = Buffer.byteLength(body);
    const options = {
      method: req.method,
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      headers: headers,
    };
    if (rewrote) process.stderr.write('[shim] normalized schema/defaults in ' + urlPath + '\n');
    let upstreamResponse;
    const proxy = http.request(options, (pres) => {
      upstreamResponse = pres;
      if (res.destroyed) {
        pres.destroy();
        return;
      }
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        process.stderr.write('[shim] client disconnected; cancelling upstream ' + urlPath + '\n');
        if (upstreamResponse) upstreamResponse.destroy();
        proxy.destroy();
      }
    });
    proxy.on('error', (e) => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy(e);
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'shim upstream error: ' + e.message } }));
    });
    proxy.write(body);
    proxy.end();
  });
}

// 每个监听规格一个独立的 server 实例：Node 同一个 server 对象多次 listen()
// 只会保留最后一个（实测），因此必须分开建。
for (const { host, port } of LISTEN_SPECS) {
  const srv = http.createServer(handleRequest);
  // 单个端口绑定失败（例如被别的进程占用）不得拖垮其它入口：只记录，不抛。
  srv.on('error', (e) => {
    process.stderr.write('[shim] listen failed on ' + host + ':' + port + ' — ' + e.message + '\n');
  });
  srv.listen(port, host, () => {
    process.stderr.write('[shim] occamy tool-schema normalizer on ' + host + ':' + port + ' -> ' + TARGET_HOST + ':' + TARGET_PORT + '\n');
  });
}
