'use strict';
const http = require('http');

const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 18100; // 默认上游（Agron），启动日志仍用

/* MB86-TOKEN-CLAMP:START
 * Agron 的输出上限是硬上限（capacity.json maxOutputTokens = 容器 --max-tokens = 2048）。
 * 超限时 gateway.mjs:105 直接 400，整轮对话失败。DSH 按 provider 的
 * defaultMaxTokens（8.6 是 32768）发请求，必然超限，所以在这里夹住。
 * 只夹会打到 Agron 的请求；deepseek-r1 走 11440 Ollama，不受影响。
 */
const AG_R1_RE = /^deepseek-r1/i;
const AG_LIMIT = Number(process.env.SHIM_AG_LIMIT || 32768); // 2026-11-04: 2048 -> 32768, override via SHIM_AG_LIMIT
function mb86IsAgronBound(m) {
  if (typeof m !== 'string' || m === '') return true;   // 无 model 名，按默认（Agron）处理
  return !AG_R1_RE.test(m);
}
function mb86ClampTokens(json) {
  if (!json || typeof json !== 'object') return;
  if (!mb86IsAgronBound(json.model)) return;
  for (const f of ['max_tokens', 'max_completion_tokens']) {
    const v = json[f];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) { delete json[f]; continue; }
    if (n === -1) continue;                 // -1 = 不限，交给 Agron 落到它自己的默认值
    if (n > AG_LIMIT) {
      process.stderr.write('[shim] clamp ' + f + ' ' + n + ' -> ' + AG_LIMIT
        + ' (model=' + json.model + ')\n');
      json[f] = AG_LIMIT;
    } else if (n < 1) {
      delete json[f];
    }
  }
  if (json.options && typeof json.options === 'object' && json.options.num_predict != null) {
    const n = Number(json.options.num_predict);
    if (Number.isFinite(n) && n !== -1 && n > AG_LIMIT) {
      process.stderr.write('[shim] clamp options.num_predict ' + n + ' -> ' + AG_LIMIT + '\n');
      json.options.num_predict = AG_LIMIT;
    }
  }
}
/* MB86-TOKEN-CLAMP:END */
/*__MB86_ROUTER__*/
// ── 多上游路由表（由 patch_shim_router_8.6.js 注入）──────────────
// 匹配规则：从上到下，第一个命中的为准；都不中则用 DEFAULT。
const MB86_UPSTREAMS = [
  { name: 'memory-bridge', host: '127.0.0.1', port: 18200,
    test: (m) => typeof m === 'string' && /^huiwen-2-agron-memory/i.test(m) },
  { name: 'ollama-r1', host: '127.0.0.1', port: 11440,
    test: (m) => typeof m === 'string' && /^deepseek-r1/i.test(m) },
];
const MB86_DEFAULT = { name: 'agron', host: TARGET_HOST, port: TARGET_PORT };
// 允许用环境变量整体关掉分流（应急回滚用，不用改文件）
const MB86_ROUTER_ON = process.env.SHIM_ROUTER !== '0';

function mb86Pick(model) {
  if (!MB86_ROUTER_ON) return MB86_DEFAULT;
  for (const u of MB86_UPSTREAMS) if (u.test(model)) return u;
  return MB86_DEFAULT;
}
// /v1/models 与 /api/tags 需要把各上游的列表合并（否则下拉选不到）
const MB86_LIST_PATHS = new Set(['/v1/models', '/api/tags']);
// 静态兜底条目：bridge 自己不实现列表端点，且它的「模型」本质是 Agron 的模型，
// 只能靠这里补一条虚拟条目，前端下拉才选得到。
const MB86_EXTRA_MODELS = [
  { id: 'huiwen-2-agron-memory:latest', name: 'huiwen-2-agron-memory:latest',
    size: 111334654784,
    digest: '9828c920376cd991daa9869b21d44e0f104ddb851ff47700786ce075c85e4cda',
    details: { format: 'gguf', family: 'huiwen-agron', families: ['huiwen-agron'],
               parameter_size: '35B', quantization_level: 'Q4_K_XL' } },
];

// 🔴 列表必须「实时向各上游拉取后合并」，不能只把静态条目 append 到默认上游的响应上。
//    原因：deepseek-r1 只存在于 11440，默认上游（Agron:18100）的列表里根本没有它；
//    不主动去 11440 拉一次，前端就永远看不到 R1 —— 那 R1 装了等于没装。
function mb86FetchList(up, urlPath) {
  return new Promise((resolve) => {
    const hdrs = { host: up.host + ':' + up.port, accept: 'application/json' };
    const r = http.request({ method: 'GET', host: up.host, port: up.port, path: urlPath,
      headers: hdrs, timeout: 5000 }, (pres) => {
      const cs = [];
      pres.on('data', (c) => cs.push(c));
      pres.on('end', () => {
        try {
          resolve({ ok: pres.statusCode === 200, obj: JSON.parse(Buffer.concat(cs).toString('utf8')) });
        } catch (_e) { resolve({ ok: false, obj: null }); }
      });
      pres.on('error', () => resolve({ ok: false, obj: null }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, obj: null }); });
    r.on('error', () => resolve({ ok: false, obj: null }));
    r.end();
  });
}
// 取某类列表的「条目数组」，/v1/models 用 data[]，/api/tags 用 models[]
function mb86Arr(obj, urlPath) {
  if (!obj || typeof obj !== 'object') return null;
  if (urlPath === '/v1/models') return Array.isArray(obj.data) ? obj.data : (obj.data = []);
  return Array.isArray(obj.models) ? obj.models : (obj.models = []);
}
function mb86IdOf(item, urlPath) {
  if (!item || typeof item !== 'object') return '';
  return urlPath === '/v1/models' ? String(item.id || '') : String(item.name || item.model || '');
}

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
    let mb86Model = null;   // /*__MB86_ROUTER__*/ 从请求体抓到的 model 名
    if (req.method === 'POST' && LLM_PATHS.has(urlPath)) {
      try {
        const json = JSON.parse(body.toString('utf8'));
        if (json && typeof json.model === 'string') mb86Model = json.model;
        mb86ClampTokens(json); // MB86-TOKEN-CLAMP
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
    const mb86Up = mb86Pick(mb86Model);
    headers['host'] = mb86Up.host + ':' + mb86Up.port;
    if (mb86Up.name !== MB86_DEFAULT.name) {
      process.stderr.write('[shim] route model=' + mb86Model + ' -> ' + mb86Up.name
        + ' (' + mb86Up.host + ':' + mb86Up.port + ') ' + urlPath + '\n');
    }
    headers['content-length'] = Buffer.byteLength(body);
    const options = {
      method: req.method,
      host: mb86Up.host,
      port: mb86Up.port,
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
      // /*__MB86_ROUTER__*/ 列表类响应必须合并各上游 + 静态条目，不能直接 pipe
      if (MB86_LIST_PATHS.has(urlPath) && pres.statusCode === 200 && req.method === 'GET') {
        const mb86Chunks = [];
        pres.on('data', (c) => mb86Chunks.push(c));
        pres.on('end', async () => {
          let payloadText = Buffer.concat(mb86Chunks).toString('utf8');
          try {
            const base = JSON.parse(payloadText);
            // ① 默认上游（Agron）的列表作为基底
            const seen = new Set();
            for (const it of mb86Arr(base, urlPath) || []) {
              const id = mb86IdOf(it, urlPath);
              if (id) seen.add(id);
            }
            // ② 向每个「真上游」实时拉列表并并入（R1 只在 11440，不拉就永远看不到）
            const lists = await Promise.all(MB86_UPSTREAMS.map((u) => mb86FetchList(u, urlPath)));
            for (let i = 0; i < MB86_UPSTREAMS.length; i++) {
              const res2 = lists[i];
              if (!res2.ok || !res2.obj) {
                process.stderr.write('[shim] list pull failed from ' + MB86_UPSTREAMS[i].name + ' ' + urlPath + '\n');
                continue;
              }
              const src = mb86Arr(res2.obj, urlPath);
              if (!Array.isArray(src)) continue;
              const dst = mb86Arr(base, urlPath);
              for (const it of src) {
                const id = mb86IdOf(it, urlPath);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                // memory 别名在 clean 层是"虚拟模型"，不该被 R1 的同名条目顶掉
                dst.push(it);
              }
            }
            // ③ 静态条目（bridge 别名，上游没有实体）
            const dst = mb86Arr(base, urlPath);
            for (const ex of MB86_EXTRA_MODELS) {
              if (seen.has(ex.id)) continue;
              seen.add(ex.id);
              if (urlPath === '/v1/models') {
                dst.push({ id: ex.id, object: 'model', owned_by: 'local', created: 0 });
              } else {
                dst.push({ name: ex.id, model: ex.id, modified_at: '2026-11-03T00:00:00Z',
                  size: ex.size, digest: ex.digest, details: ex.details });
              }
            }
            payloadText = JSON.stringify(base);
          } catch (e) {
            process.stderr.write('[shim] list merge failed, passthrough: ' + e.message + '\n');
          }
          const hdr = Object.assign({}, pres.headers);
          delete hdr['transfer-encoding'];
          delete hdr['content-length'];
          hdr['content-length'] = Buffer.byteLength(payloadText);
          res.writeHead(pres.statusCode, hdr);
          res.end(payloadText);
        });
        pres.on('error', () => { try { res.end(); } catch (_e) {} });
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
