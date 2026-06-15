const https = require('https');

const SERVER   = 'https://campelo.c2018.xyz:443';
const USERNAME = 'Nk2XcKzrgvBq';
const PASSWORD = 'xhma8TBna9Qx';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const apiUrl = `${SERVER}/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=get_live_categories`;
  const parsed = new URL(apiUrl);

  https.get(
    { hostname: parsed.hostname, port: parsed.port || 443, path: parsed.pathname + parsed.search, headers: { 'User-Agent': 'Mozilla/5.0' }, rejectUnauthorized: false },
    proxyRes => {
      let body = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', c => { body += c; });
      proxyRes.on('end', () => {
        try {
          const data = JSON.parse(body);
          res.setHeader('Content-Type', 'application/json');
          res.status(200).json(data.map(c => ({ id: c.category_id, name: c.category_name })));
        } catch { res.status(502).json({ error: 'parse error' }); }
      });
    }
  ).on('error', err => res.status(502).json({ error: err.message }));
};
