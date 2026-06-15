const https = require('https');
const http = require('http');
const { URL } = require('url');

const SERVER   = 'https://campelo.c2018.xyz:443';
const USERNAME = 'Nk2XcKzrgvBq';
const PASSWORD = 'xhma8TBna9Qx';

const REFERERS = {
  'rtp.pt':             'https://www.rtp.pt/',
  'streaming-live.rtp': 'https://www.rtp.pt/',
  'iol.pt':             'https://tviplayer.iol.pt/',
  'content.sic':        'https://sic.pt/',
  'cmtv':               'https://cmtv.pt/',
  'record.pt':          'https://www.record.pt/',
};

function getReferer(url) {
  for (const [k, v] of Object.entries(REFERERS)) {
    if (url.includes(k)) return v;
  }
  return '';
}

function makeAbsolute(line, baseUrl, origin) {
  if (!line || line.startsWith('#')) return line;
  line = line.trim();
  if (!line) return line;
  if (line.startsWith('http://') || line.startsWith('https://')) return line;
  if (line.startsWith('/')) return origin + line;
  return baseUrl + line;
}

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { ch, type, url: rawUrl } = req.query;

  let targetUrl = '';

  if (ch) {
    // Xtream mode — constrói URL com credenciais escondidas
    const t = type || 'live';
    targetUrl = `${SERVER}/${t}/${USERNAME}/${PASSWORD}/${ch}.m3u8`;
  } else if (rawUrl) {
    targetUrl = rawUrl;
  } else {
    res.status(400).json({ error: 'ch or url required' });
    return;
  }

  let parsed;
  try { parsed = new URL(targetUrl); }
  catch (e) { res.status(400).json({ error: 'invalid url' }); return; }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    res.status(400).json({ error: 'protocol not allowed' });
    return;
  }

  const referer = getReferer(targetUrl);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
  };
  if (referer) {
    headers['Referer'] = referer;
    headers['Origin'] = new URL(referer).origin;
  }

  const lib = parsed.protocol === 'https:' ? https : http;

  const doRequest = (reqUrl, redirectCount = 0) => {
    if (redirectCount > 5) {
      if (!res.headersSent) res.status(502).json({ error: 'too many redirects' });
      return;
    }

    let p;
    try { p = new URL(reqUrl); } catch(e) {
      if (!res.headersSent) res.status(400).json({ error: 'bad redirect url' });
      return;
    }

    const l = p.protocol === 'https:' ? https : http;

    const proxyReq = l.request({
      hostname: p.hostname,
      port: p.port || (p.protocol === 'https:' ? 443 : 80),
      path: p.pathname + p.search,
      method: 'GET',
      headers,
      rejectUnauthorized: false,
    }, (proxyRes) => {

      const status = proxyRes.statusCode;

      // Follow redirects
      if ([301, 302, 303, 307, 308].includes(status)) {
        const loc = proxyRes.headers['location'];
        if (loc) {
          proxyRes.resume();
          const nextUrl = loc.startsWith('http') ? loc : `${p.protocol}//${p.host}${loc}`;
          doRequest(nextUrl, redirectCount + 1);
          return;
        }
      }

      const ct = proxyRes.headers['content-type'] || '';
      const url_ = reqUrl;
      const isM3U = url_.includes('.m3u8') || url_.includes('.m3u') ||
                    ct.includes('mpegurl') || ct.includes('x-mpegurl');

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-cache, no-store');

      if (isM3U) {
        // Reescreve o manifesto M3U8
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        let body = '';
        proxyRes.setEncoding('utf8');
        proxyRes.on('data', c => { body += c; });
        proxyRes.on('end', () => {
          const baseUrl = url_.substring(0, url_.lastIndexOf('/') + 1);
          const origin  = `${p.protocol}//${p.host}`;

          const rewritten = body.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            const abs = makeAbsolute(trimmed, baseUrl, origin);
            // Todos os segmentos e sub-manifests passam pelo proxy
            return `/api/stream?url=${encodeURIComponent(abs)}`;
          }).join('\n');

          res.status(status).send(rewritten);
        });
      } else {
        // Segmento binário (.ts, .aac, .mp4) — pipe direto
        const resCt = ct || 'video/MP2T';
        res.setHeader('Content-Type', resCt);
        if (proxyRes.headers['content-length']) {
          res.setHeader('Content-Length', proxyRes.headers['content-length']);
        }
        res.status(status);
        proxyRes.pipe(res, { end: true });
      }
    });

    proxyReq.on('error', err => {
      console.error('Proxy error:', err.message, 'URL:', reqUrl);
      if (!res.headersSent) res.status(502).json({ error: 'upstream error', msg: err.message });
    });

    proxyReq.setTimeout(20000, () => {
      proxyReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'timeout' });
    });

    proxyReq.end();
  };

  doRequest(targetUrl);
};
