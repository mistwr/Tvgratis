const https = require('https');
const http  = require('http');
const { URL } = require('url');

const SERVER   = 'https://campelo.c2018.xyz:443';
const USERNAME = 'Nk2XcKzrgvBq';
const PASSWORD = 'xhma8TBna9Qx';

// ═══════════════════════════════════════════
// CACHE EM MEMÓRIA (por instância de função)
// Reduz pedidos repetidos ao Xtream quando
// várias pessoas pedem o mesmo canal quase
// ao mesmo tempo (dentro da mesma instância)
// ═══════════════════════════════════════════
const MANIFEST_CACHE = new Map(); // key -> { body, expires }
const CACHE_TTL_MS = 3000; // 3 segundos — suficiente para absorver picos

function getCached(key) {
  const entry = MANIFEST_CACHE.get(key);
  if (entry && entry.expires > Date.now()) return entry.body;
  return null;
}

function setCached(key, body) {
  MANIFEST_CACHE.set(key, { body, expires: Date.now() + CACHE_TTL_MS });
  // Limpa entradas antigas para não crescer infinitamente
  if (MANIFEST_CACHE.size > 200) {
    const now = Date.now();
    for (const [k, v] of MANIFEST_CACHE) {
      if (v.expires < now) MANIFEST_CACHE.delete(k);
    }
  }
}

// ═══════════════════════════════════════════
// PEDIDOS EM VOO — evita duplicar pedidos ao
// Xtream quando chegam vários ao mesmo tempo
// (request coalescing)
// ═══════════════════════════════════════════
const IN_FLIGHT = new Map(); // key -> Promise

function fetchManifestOnce(key, fetcher) {
  if (IN_FLIGHT.has(key)) return IN_FLIGHT.get(key);
  const p = fetcher().finally(() => IN_FLIGHT.delete(key));
  IN_FLIGHT.set(key, p);
  return p;
}

function fetchRaw(targetUrl, headers) {
  return new Promise((resolve, reject) => {
    const doReq = (url, hops = 0) => {
      if (hops > 5) { reject(new Error('too many redirects')); return; }
      let p;
      try { p = new URL(url); } catch (e) { reject(e); return; }
      const lib = p.protocol === 'https:' ? https : http;

      const r = lib.request({
        hostname: p.hostname,
        port: p.port || (p.protocol === 'https:' ? 443 : 80),
        path: p.pathname + p.search,
        method: 'GET',
        headers,
        rejectUnauthorized: false,
      }, (upstream) => {
        const status = upstream.statusCode;
        if ([301, 302, 303, 307, 308].includes(status) && upstream.headers.location) {
          upstream.resume();
          const loc = upstream.headers.location;
          const next = loc.startsWith('http') ? loc : `${p.protocol}//${p.host}${loc}`;
          doReq(next, hops + 1);
          return;
        }
        let body = '';
        upstream.setEncoding('utf8');
        upstream.on('data', c => { body += c; });
        upstream.on('end', () => resolve({ status, body, finalUrl: url, headers: upstream.headers }));
      });
      r.on('error', reject);
      r.setTimeout(15000, () => { r.destroy(); reject(new Error('timeout')); });
      r.end();
    };
    doReq(targetUrl);
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { ch, type, url: rawUrl } = req.query;

  let targetUrl = '';
  let cacheKey = '';

  if (ch) {
    const t = type || 'live';
    if (t === 'movie' || t === 'series') {
      targetUrl = `${SERVER}/movie/${USERNAME}/${PASSWORD}/${ch}.mp4`;
    } else {
      targetUrl = `${SERVER}/live/${USERNAME}/${PASSWORD}/${ch}.m3u8`;
    }
    cacheKey = `ch:${t}:${ch}`;
  } else if (rawUrl) {
    targetUrl = rawUrl;
    cacheKey = `url:${rawUrl}`;
  } else {
    res.status(400).json({ error: 'ch or url required' });
    return;
  }

  let parsed;
  try { parsed = new URL(targetUrl); } catch (e) { res.status(400).json({ error: 'invalid url' }); return; }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': '*/*',
    'Connection': 'keep-alive',
  };

  const isM3UGuess = targetUrl.includes('.m3u8') || targetUrl.includes('.m3u');

  // ── MANIFESTOS: cache + coalescing partilhado entre utilizadores ──
  if (isM3UGuess) {
    // 1. Cache hit — serve imediatamente, sem tocar no Xtream
    const cached = getCached(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Cache', 'HIT');
      res.status(200).send(cached);
      return;
    }

    try {
      // 2. Coalescing — se já há um pedido igual em curso, todos esperam pelo mesmo
      const result = await fetchManifestOnce(cacheKey, () => fetchRaw(targetUrl, headers));

      const finalP = new URL(result.finalUrl);
      const base = result.finalUrl.substring(0, result.finalUrl.lastIndexOf('/') + 1);
      const origin = `${finalP.protocol}//${finalP.host}`;

      const rewritten = result.body.split('\n').map(line => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line;
        let abs = t;
        if (!t.startsWith('http')) abs = t.startsWith('/') ? origin + t : base + t;
        // Sub-manifests (variantes de qualidade) continuam via proxy
        if (abs.includes('.m3u8') || abs.includes('.m3u')) {
          return `/api/stream?url=${encodeURIComponent(abs)}`;
        }
        // Segmentos vão DIRETOS ao servidor de origem (não passam pelo Vercel)
        return abs;
      }).join('\n');

      setCached(cacheKey, rewritten);

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Cache', 'MISS');
      res.status(result.status || 200).send(rewritten);
    } catch (err) {
      res.status(502).json({ error: 'upstream error', msg: err.message });
    }
    return;
  }

  // ── NÃO-MANIFESTO (segmentos, fallback) — pipe direto, sem cache ──
  const lib = parsed.protocol === 'https:' ? https : http;
  const doReq = (url, hops = 0) => {
    if (hops > 5) { if (!res.headersSent) res.status(502).json({ error: 'too many redirects' }); return; }
    let p;
    try { p = new URL(url); } catch (e) { if (!res.headersSent) res.status(400).end(); return; }
    const l = p.protocol === 'https:' ? https : http;

    const r = l.request({
      hostname: p.hostname,
      port: p.port || (p.protocol === 'https:' ? 443 : 80),
      path: p.pathname + p.search,
      method: 'GET',
      headers,
      rejectUnauthorized: false,
    }, (upstream) => {
      const status = upstream.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && upstream.headers.location) {
        upstream.resume();
        const loc = upstream.headers.location;
        const next = loc.startsWith('http') ? loc : `${p.protocol}//${p.host}${loc}`;
        doReq(next, hops + 1);
        return;
      }
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/MP2T');
      if (upstream.headers['content-length']) res.setHeader('Content-Length', upstream.headers['content-length']);
      res.status(status);
      upstream.pipe(res);
    });
    r.on('error', err => { if (!res.headersSent) res.status(502).json({ error: err.message }); });
    r.setTimeout(15000, () => { r.destroy(); if (!res.headersSent) res.status(504).json({ error: 'timeout' }); });
    r.end();
  };
  doReq(targetUrl);
};
