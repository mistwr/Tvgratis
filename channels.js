const https = require('https');
const http = require('http');

const SERVER   = 'https://campelo.c2018.xyz:443';
const USERNAME = 'Nk2XcKzrgvBq';
const PASSWORD = 'xhma8TBna9Qx';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { cat } = req.query;
  const apiUrl = `${SERVER}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_live_streams${cat ? `&category_id=${cat}` : ''}`;

  const parsed = new URL(apiUrl);
  const lib = parsed.protocol === 'https:' ? https : http;

  const proxyReq = lib.request(
    {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      rejectUnauthorized: false,
    },
    proxyRes => {
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', c => { body += c; });
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          // Remove quaisquer referências ao servidor/credenciais
          const clean = data.map(ch => ({
            id: ch.stream_id,
            name: ch.name,
            logo: ch.stream_icon,
            group: ch.category_name || '',
            // URL do stream passa sempre pelo proxy
            url: `/api/stream?ch=${ch.stream_id}`,
          }));
          res.setHeader('Content-Type', 'application/json');
          res.status(200).json(clean);
        } catch (e) {
          res.status(502).json({ error: 'parse error' });
        }
      });
    }
  );

  proxyReq.on('error', err => {
    if (!res.headersSent) res.status(502).json({ error: err.message });
  });
  proxyReq.setTimeout(15000, () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'timeout' });
  });
  proxyReq.end();
};
