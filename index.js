/* Render (yoki oddiy Node server) uchun. Vercel bu faylni ishlatmaydi. */
'use strict';
const http = require('http');
const photo = require('./api/photo');
const health = require('./api/health');
const PORT = process.env.PORT || 3000;
function wrap(res) {
  res.status = c => { res.statusCode = c; return res; };
  res.json = o => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
  return res;
}
http.createServer((req, res) => {
  wrap(res);
  const url = req.url.split('?')[0];
  if (url === '/' ) return res.status(200).json({ ok: true, app: 'meyor-ai' });
  if (url === '/api/health') return health(req, res);
  if (url === '/api/photo') {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 8e6) { req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch (e) { req.body = {}; } photo(req, res); });
    return;
  }
  res.status(404).json({ error: 'Topilmadi' });
}).listen(PORT, () => console.log('meyor-ai ishga tushdi, port ' + PORT));
