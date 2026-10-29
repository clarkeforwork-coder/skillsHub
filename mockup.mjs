// UI mockup only: static files, no API, no persistence or installed Skill access.
import http from 'node:http';
import fs from 'node:fs/promises';
const files = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'] };
http.createServer(async (req, res) => {
  const file = files[new URL(req.url, 'http://localhost').pathname];
  if (!file || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8' });
  res.end(await fs.readFile(new URL('./public/prototype/' + file[0], import.meta.url)));
}).listen(4311, '127.0.0.1', () => console.log('SkillsHub mockup: http://127.0.0.1:4311'));
