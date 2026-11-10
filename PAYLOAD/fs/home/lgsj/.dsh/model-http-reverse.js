'use strict';
/**
 * Local HTTP bridge to the configured HTTPS model endpoint.
 * Outbound requests verify TLS and use the configured GPT proxy when set.
 * Each request owns its dispatcher; response closure releases its sockets.
 * Service: dsh-model-http.service, port 25444.
 */

const http = require('http');
// Import fetch and ProxyAgent from the same undici build so the dispatcher
// handed to fetch() is the same implementation that executes the request
// (mixing Node's built-in fetch with a ProxyAgent from another undici build
// fails with UND_ERR_INVALID_ARG / "invalid onRequestStart method").
const {
  Agent,
  ProxyAgent,
  Pool,
  buildConnector,
  fetch,
  request,
} = require('/home/lgsj/deepseek-harness.dsh-v0.1.7-alpha.2/node_modules/.pnpm/undici@8.10.0/node_modules/undici');

const LISTEN_HOST = process.env.HTTP_BRIDGE_LISTEN_HOST || '0.0.0.0';
const LISTEN_PORT = parseInt(process.env.HTTP_BRIDGE_LISTEN_PORT || '25444', 10);
const TARGET_HOST = process.env.HTTP_BRIDGE_TARGET_HOST || '45.76.203.143';
const TARGET_PORT = parseInt(process.env.HTTP_BRIDGE_TARGET_PORT || '25443', 10);

const TARGET_SNI = process.env.HTTP_BRIDGE_TARGET_SNI || TARGET_HOST;
const TARGET_HOST_HEADER = process.env.HTTP_BRIDGE_TARGET_HOST_HEADER || `${TARGET_HOST}:${TARGET_PORT}`;
const TARGET_ORIGIN = `https://${TARGET_HOST}:${TARGET_PORT}`;
function retryConnect(connect, isClosed, onRetry) {
  const transient = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);
  return (options, callback) => {
    let attempts = 0;
    const aborted = () => Object.assign(new Error('Client disconnected'), { code: 'ABORT_ERR' });
    const attempt = () => {
      if (isClosed()) return callback(aborted());
      attempts += 1;
      connect(options, (error, socket) => {
        if (isClosed()) {
          socket?.destroy();
          return callback(aborted());
        }
        if (error && transient.has(error.code) && attempts < 3) {
          onRetry(error, attempts);
          setTimeout(attempt, 250 * attempts);
          return;
        }
        callback(error, socket);
      });
    };
    attempt();
  };
}

const createDispatcher = (res, requestId) => process.env.HTTP_BRIDGE_PROXY_URL
  ? new ProxyAgent({
      uri: process.env.HTTP_BRIDGE_PROXY_URL,
      connectTimeout: 8000,
      requestTls: { rejectUnauthorized: true, servername: TARGET_SNI },
      factory: (origin, options) => new Pool(origin, {
        ...options,
        connect: retryConnect(
          options.connect,
          () => res.destroyed,
          (error, attempts) => log(JSON.stringify({requestId, phase: 'proxy-connect-retry', code: error.code, attempts}))
        )
      })
    })
  : new Agent({
  connect: retryConnect(
    buildConnector({ timeout: 8000, servername: TARGET_SNI }),
    () => res.destroyed,
    (error, attempts) => log(JSON.stringify({requestId, phase: 'connect-retry', code: error.code, attempts}))
  )
});

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

const server = http.createServer((req, res) => {
  // Each request owns its upstream connection and closes it with the response.
  const started = Date.now();
  const requestId = require('crypto').randomUUID().slice(0, 8);
  log(JSON.stringify({requestId, method: req.method, path: req.url.split('?')[0], bytes: req.headers['content-length'], encoding: req.headers['content-encoding'], acceptEncoding: req.headers['accept-encoding'], connection: req.headers.connection}));
  const dispatcher = createDispatcher(res, requestId);
  res.once('close', () => { dispatcher.destroy().catch(() => {}); });
  const targetUrl = TARGET_ORIGIN + req.url;
  const headers = { ...req.headers, host: TARGET_HOST_HEADER };

  let upstream;
  const forward = async () => {
    try {
      upstream = await request(targetUrl, {
        method: req.method,
        headers,
        body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req,
        dispatcher,
      });
    } catch (e) {
      if (res.destroyed) return;
      const msg = `bridge upstream error: ${e.cause?.code || e.code || e.message}`;
      log(JSON.stringify({requestId, error: msg, elapsed: Date.now() - started, socket: e.cause?.socket}));
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(msg);
      return;
    }
    log(JSON.stringify({requestId, status: upstream.statusCode, elapsed: Date.now() - started, encoding: upstream.headers['content-encoding'], bytes: upstream.headers['content-length']}));
    res.writeHead(upstream.statusCode, upstream.headers);
    // Stream the body through (SSE chat completions stay live).
    const pump = async () => {
      let responseBytes = 0;
      try {
        for await (const value of upstream.body) {
          responseBytes += value.length;
          if (!res.write(value)) {
            await new Promise((r) => res.once('drain', r));
          }
        }
        res.end();
        log(JSON.stringify({requestId, completed: true, responseBytes, elapsed: Date.now() - started}));
      } catch (e) {
        if (res.destroyed) return;
        log(JSON.stringify({requestId, streamError: e.message, cause: e.cause?.code, elapsed: Date.now() - started, socket: e.cause?.socket}));
        res.destroy();
      }
    };
    pump();
  };
  forward();
});

server.on('error', (e) => {
  log(`server error: ${e.code || e.message}`);
  process.exit(1);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(
    `listening on ${LISTEN_HOST}:${LISTEN_PORT} ` +
    `(${process.env.HTTP_BRIDGE_PROXY_URL ? 'GPT proxy' : 'direct'} -> ${TARGET_ORIGIN})`
  );
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
