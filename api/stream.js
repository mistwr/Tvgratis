const https = require('https');
const http = require('http');
const { URL } = require('url');

// ═══════════════════════════════════════════
// CREDENCIAIS ESCONDIDAS — nunca expostas
// ═══════════════════════════════════════════
const SERVER   = 'https://campelo.c2018.xyz:443';
const USERNAME = 'Nk2XcKzrgvBq';
const PASSWORD = 'xhma8TBna9Qx';

// ═══════════════════════════════════════════
// REFERERS por domínio (canais públicos)
// ═══════════════════════════════════════════
const REFERERS = {
  'rtp.pt':           'https://www.rtp.pt/',
  'streaming-live.rtp': 'https://www.rtp.pt/',
  'iol.pt':           'https://tviplayer.iol.pt/',
  'content.sic':      'https://sic.pt/',
  'cmtv':             'https://cmtv.pt/',
  'record.pt':        'https://www.record.pt/',
};

function getReferer(url) {
  for (const [k, v] of Object.entries(REFERERS)) {
    if (url.includes(k)) return v;
  }
  return '';
}

// ═══════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { ch, type, url: rawUrl } = req.query;

  let targetUrl = '';

  if (ch) {
    // ── MODO XTREAM: /api/stream?ch=CHANNEL_ID&type=live ──
    // Monta o URL Xtream com credenciais escondidas
    const t = type || 'live';
    targetUrl = `${SERVER}/${t}/${USERNAME}/${PASSWORD}/${ch}`;
    // Se não tiver extensão, tenta .m3u8
    if (!targetUrl.includes('.')) targetUrl += '.m3u8';

  } else if (rawUrl) {
    // ── MODO PROXY DIRETO: /api/stream?url=... ──
    // Para canais públicos (RTP, SIC, etc.)
    targetUrl = rawUrl;

  } else {
    res.status(400).json({ error: 'Parâmetro ch ou url obrigatório' });
    return;
  }

  // Validar URL
  let parsed;
  try { parsed = new URL(targetUrl); }
  catch (e) { res.status(400).json({ error: 'URL inválido' }); return; }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    res.status(400).json({ error: 'Protocolo não permitido' });
    return;
  }

  const referer = getReferer(targetUrl);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'pt-PT,pt;q=0.9',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
  };
  if (referer) {
    headers['Referer'] = referer;
    headers['Origin'] = new URL(referer).origin;
  }

  const lib = parsed.protocol === 'https:' ? https : http;

  const proxyReq = lib.request(
    {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      rejectUnauthorized: false, // alguns servidores IPTV têm certs self-signed
    },
    (proxyRes) => {
      const ct = proxyRes.headers['content-type'] || '';
      const isM3U = targetUrl.includes('.m3u8') || ct.includes('mpegurl') || ct.includes('m3u');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store');
      res.setHeader('Content-Type', ct || 'application/vnd.apple.mpegurl');

      if (proxyRes.statusCode === 301 || proxyRes.statusCode === 302) {
        // Follow redirect
        const location = proxyRes.headers['location'];
        if (location) {
          res.redirect(`/api/stream?url=${encodeURIComponent(location)}`);
          return;
        }
      }

      if (isM3U) {
        // Reescreve M3U8 — todos os segmentos passam pelo proxy
        let body = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', c => { body += c; });
        proxyRes.on('end', () => {
          const base = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
          const lines = body.split('\n').map(line => {
            const l = line.trim();
            if (!l || l.startsWith('#')) return line;
            let abs = l;
            if (!l.startsWith('http')) {
              abs = l.startsWith('/') ? `${parsed.protocol}//${parsed.host}${l}` : base + l;
            }
            return `/api/stream?url=${encodeURIComponent(abs)}`;
          });
          res.status(proxyRes.statusCode || 200).send(lines.join('\n'));
        });
      } else {
        // Stream binário (segmentos .ts, .aac, etc.) — pipe direto
        res.status(proxyRes.statusCode || 200);
        proxyRes.pipe(res, { end: true });
      }
    }
  );

  proxyReq.on('error', err => {
    console.error('Proxy error:', err.message);
    if (!res.headersSent) res.status(502).json({ error: 'upstream error' });
  });

  proxyReq.setTimeout(20000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'timeout' });
  });

  proxyReq.end();
};
