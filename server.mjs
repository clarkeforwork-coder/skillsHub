import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillStore } from './lib/store.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const store = await new SkillStore(process.env.SKILLSHUB_DATA || path.join(root, '.data')).init();
// Preview tokens are process-local; snapshots left after a restart are no longer usable.
await fs.rm(path.join(store.root, 'staging'), { recursive: true, force: true });
const port = Number(process.env.PORT || 4310);
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(req.headers.host)) return send(403, { error: 'Host 不允許' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: '不允許跨來源存取' });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/api/skills') return send(200, await store.list());
    if (req.method === 'GET' && /^\/api\/skills\/[a-f0-9-]+$/.test(url.pathname)) return send(200, await store.detail(url.pathname.split('/').at(-1)));
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-skillshub-request'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: '需要本機管理介面的請求標頭' });
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 100000) throw new Error('請求太大'); }
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/api/folders') return send(200, await store.browseFolders(body.path));
      if (url.pathname === '/api/projects/add') return send(200, await store.mutate(() => store.addProject(body.path)));
      if (url.pathname === '/api/projects/remove') return send(200, await store.mutate(() => store.removeProject(body.id)));
      if (url.pathname === '/api/project-configuration') return send(200, await store.projectConfiguration(body.tool, body.project));
      if (url.pathname === '/api/import') return send(200, await store.mutate(() => body.type === 'github' ? store.importGitHub(body.location, body.subdirectory) : store.importLocal(body.location)));
      if (url.pathname === '/api/update') return send(200, await store.mutate(() => store.update(body.id, body)));
      if (url.pathname === '/api/packs/save') return send(200, await store.mutate(() => store.savePack(body)));
      if (url.pathname === '/api/packs/delete') return send(200, await store.mutate(() => store.deletePack(body.id, body.revision)));
      if (url.pathname === '/api/adoption/preview') return send(200, await store.previewAdoption(body));
      if (url.pathname === '/api/adoption/confirm') return send(200, await store.mutate(() => store.confirmAdoption(body.token,body.ids)));
      if (url.pathname === '/api/source/preview') return send(200, await store.previewSourceUpdate(body.id));
      if (url.pathname === '/api/source/confirm') return send(200, await store.mutate(() => store.confirmSourceUpdate(body.token)));
      if (url.pathname === '/api/collection/remove-preview') return send(200, await store.previewRemoval(body.id));
      if (url.pathname === '/api/collection/remove-confirm') return send(200, await store.mutate(() => store.confirmRemoval(body.token)));
      if (url.pathname === '/api/installation-targets') return send(200, await store.installationTargets(body.ids,body.packId));
      if (url.pathname === '/api/plan') return send(200, await store.previewInstall(body.ids, body.tool, body.scope, body.project, body.packId, body.detach, body.linkExisting === true));
      if (url.pathname === '/api/install') return send(200, await store.mutate(() => store.confirmInstall(body.token)));
      return send(404, { error: '找不到操作' });
    }
    const assets = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
    if (req.method !== 'GET' || !assets[url.pathname]) return send(404, { error: '找不到頁面' });
    const file = assets[url.pathname];
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control': 'no-cache' });
    res.end(await fs.readFile(path.join(root, 'public', file)));
  } catch (error) { send(400, { error: error.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`SkillsHub: http://127.0.0.1:${port}`));
