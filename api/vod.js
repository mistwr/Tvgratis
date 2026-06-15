const https = require('https');

const SERVER   = 'https://campelo.c2018.xyz:443';
const USERNAME = 'Nk2XcKzrgvBq';
const PASSWORD = 'xhma8TBna9Qx';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { action, cat, id, page } = req.query;
  // action: cats_vod | vod | series_cats | series | series_info
  const act = action || 'get_vod_categories';
  let path = `/player_api.php?username=${USERNAME}&password=${PASSWORD}&action=${act}`;
  if (cat)  path += `&category_id=${cat}`;
  if (id)   path += `&vod_id=${id}&series_id=${id}`;
  if (page) path += `&page=${page}`;

  const parsed = new URL(SERVER);
  https.get({
    hostname: parsed.hostname,
    port: parsed.port || 443,
    path,
    headers: { 'User-Agent': 'Mozilla/5.0' },
    rejectUnauthorized: false,
  }, proxyRes => {
    let body = '';
    proxyRes.setEncoding('utf8');
    proxyRes.on('data', c => { body += c; });
    proxyRes.on('end', () => {
      try {
        const data = JSON.parse(body);

        // Clean response — never expose server/credentials
        let clean;
        if (act === 'get_vod_categories' || act === 'get_series_categories') {
          clean = data.map(c => ({ id: c.category_id, name: c.category_name, count: c.parent_id }));
        } else if (act === 'get_vod_streams') {
          clean = data.map(v => ({
            id: v.stream_id,
            name: v.name,
            cover: v.stream_icon || v.cover,
            rating: v.rating,
            year: v.year,
            genre: v.category_name || '',
            // Stream URL via proxy
            url: `/api/stream?ch=${v.stream_id}&type=movie`,
          }));
        } else if (act === 'get_series') {
          clean = data.map(s => ({
            id: s.series_id,
            name: s.name,
            cover: s.cover,
            rating: s.rating,
            year: s.year,
            genre: s.category_name || '',
            seasons: s.episode_run_time,
          }));
        } else if (act === 'get_series_info') {
          // Series detail with episodes
          clean = {
            info: {
              name: data.info?.name,
              cover: data.info?.cover,
              plot: data.info?.plot,
              cast: data.info?.cast,
              director: data.info?.director,
              genre: data.info?.genre,
              rating: data.info?.rating,
            },
            episodes: Object.entries(data.episodes || {}).reduce((acc, [season, eps]) => {
              acc[season] = eps.map(ep => ({
                id: ep.id,
                title: ep.title,
                episode: ep.episode_num,
                season: ep.season,
                duration: ep.info?.duration_secs,
                url: `/api/stream?ch=${ep.id}&type=series`,
              }));
              return acc;
            }, {}),
          };
        } else if (act === 'get_vod_info') {
          clean = {
            info: data.info,
            url: `/api/stream?ch=${id}&type=movie`,
          };
        } else {
          clean = data;
        }

        res.setHeader('Content-Type', 'application/json');
        res.status(200).json(clean);
      } catch(e) {
        res.status(502).json({ error: 'parse error', raw: body.slice(0, 200) });
      }
    });
  }).on('error', err => res.status(502).json({ error: err.message }));
};
