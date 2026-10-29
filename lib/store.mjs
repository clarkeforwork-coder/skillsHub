import { installationTargets } from './installation-targets.mjs';
import { previewRemoval, confirmRemoval } from './collection.mjs';
import { prunePreviews, previewSourceUpdate, confirmSourceUpdate, fileChanges } from './updates.mjs';
import { previewAdoption, confirmAdoption } from './adoption.mjs';
import { noteOwnership, planSync, confirmSync } from './sync.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const exec = promisify(execFile);
const excluded = new Set(['.git', 'node_modules', '.DS_Store']);
const skillConfigDirectories = new Set(['.claude', '.agents', '.codex', '.cursor', '.github', '.gemini']);
const exists = async p => { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const expand = p => p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
const validName = n => typeof n === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n) && n.length <= 64;

export class SkillStore {
  constructor(root, home = os.homedir()) { this.root = root; this.home = home; this.queue = Promise.resolve(); this.previews = new Map(); }
  async init() {
    await fs.mkdir(path.join(this.root, 'library'), { recursive: true });
    try { this.db = JSON.parse(await fs.readFile(path.join(this.root, 'catalog.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; this.db = { skills: [], installs: [] }; }
    if (!this.db.packs) {
      if (await exists(path.join(this.root, 'catalog.json'))) {
        try { await fs.copyFile(path.join(this.root, 'catalog.json'), path.join(this.root, 'catalog.before-v2.json'), 1); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
      }
      this.db.packs = [];
    }
    const migrateProjects = !this.db.projects;
    this.db.projects ||= [];
    for (const record of (migrateProjects ? this.db.installs : []).filter(r => r.scope === 'project')) {
      const location = path.dirname(path.dirname(path.dirname(record.destination)));
      if (!this.db.projects.some(p => p.path === location)) this.db.projects.push({ id: randomUUID(), name: path.basename(location), path: location });
    }
    return this;
  }
  mutate(fn) {
    const job = this.queue.then(async () => {
      const before = structuredClone(this.db);
      this.rollbackOperations = [];
      const temp = path.join(this.root, `catalog-${randomUUID()}.tmp`);
      try {
        const result = await fn();
        await fs.writeFile(temp, JSON.stringify(this.db, null, 2), { mode: 0o600 });
        await fs.rename(temp, path.join(this.root, 'catalog.json'));
        return result;
      } catch (error) {
        for (const undo of this.rollbackOperations.reverse()) await undo().catch(() => {});
        this.db = before;
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
    });
    this.queue = job.catch(() => {});
    return job;
  }
  folder(id) { return path.join(this.root, 'library', id); }
  skill(id) { const s = this.db.skills.find(s => s.id === id); if (!s) throw new Error('找不到這個 Skill'); return s; }
  async tree(root, strict = false) {
    const files = []; let bytes = 0;
    const walk = async (dir, relative = '') => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (!strict && excluded.has(entry.name)) continue;
        const rel = path.join(relative, entry.name), full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`不支援附帶符號連結的 Skill：${rel}`);
        if (entry.isDirectory()) await walk(full, rel);
        else if (entry.isFile()) {
          bytes += (await fs.stat(full)).size;
          if (bytes > 25 * 1024 * 1024 || files.length >= 2000) throw new Error('Skill 超過 25 MB 或 2,000 個檔案的限制');
          files.push(rel);
        } else throw new Error(`不支援特殊檔案：${rel}`);
      }
    };
    await walk(root); return files.sort();
  }
  async fingerprint(root, strict = false) {
    const hash = createHash('sha256');
    for (const file of await this.tree(root, strict)) {
      const data = await fs.readFile(path.join(root, file));
      hash.update(JSON.stringify([file, data.length])); hash.update(data);
    }
    return hash.digest('hex');
  }
  async copy(source, dest) {
    for (const rel of await this.tree(source)) {
      const target = path.join(dest, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(source, rel), target, 1);
      await fs.chmod(target, (await fs.stat(path.join(source, rel))).mode & 0o777);
    }
  }
  async metadata(folder) {
    const content = await fs.readFile(path.join(folder, 'SKILL.md'), 'utf8');
    const match = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!match) throw new Error('SKILL.md 缺少 YAML frontmatter');
    const meta = parse(match[1], { maxAliasCount: 20 });
    if (!validName(meta?.name) || typeof meta.description !== 'string' || !meta.description.trim()) throw new Error('Skill 需要有效的 name（小寫英文、數字、連字號，最多 64 字）與 description');
    return { name: meta.name, description: meta.description.trim(), content };
  }
  async importLocal(input, provenance) {
    if (typeof input !== 'string' || !input.trim()) throw new Error('請輸入 Skill 或收藏資料夾路徑');
    const source = await fs.realpath(expand(input.trim()));
    if (!(await fs.stat(source)).isDirectory()) throw new Error('來源必須是資料夾');
    const candidates = [];
    const scan = async (dir, depth = 0) => {
      if (await exists(path.join(dir, 'SKILL.md'))) { candidates.push(dir); return; }
      if (depth >= 3 || candidates.length >= 300) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (excluded.has(entry.name) || (entry.name.startsWith('.') && !skillConfigDirectories.has(entry.name))) continue;
        if (entry.isDirectory()) await scan(path.join(dir, entry.name), depth + 1);
      }
    };
    await scan(source);
    if (!candidates.length) throw new Error('找不到 SKILL.md；可指定單一 Skill 或包含 Skills 的資料夾（最多掃描三層）');
    const results = [];
    for (const dir of candidates) {
      let dest;
      try {
        const meta = await this.metadata(dir), digest = await this.fingerprint(dir);
        const origin = provenance ? { ...provenance, subdirectory: path.relative(provenance.checkout, dir) } : { type: 'local', location: dir };
        delete origin.checkout;
        if (this.db.skills.some(s => s.digest === digest)) { results.push({ name: meta.name, status: 'skipped', message: '相同內容已收錄' }); continue; }
        const id = randomUUID(); dest = this.folder(id);
        await fs.mkdir(dest); await this.copy(dir, dest);
        this.db.skills.push({ id, name: meta.name, description: meta.description, source: origin, digest, tags: [], notes: '', favorite: false, createdAt: new Date().toISOString() });
        results.push({ name: meta.name, status: 'imported' });
      } catch (e) {
        if (dest) await fs.rm(dest, { recursive: true, force: true });
        results.push({ name: path.basename(dir), status: 'error', message: e.message });
      }
    }
    return results;
  }
  async importGitHub(url, subdirectory = '') {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(parsed.pathname)) throw new Error('請使用 GitHub 儲存庫網址：https://github.com/owner/repo；子資料夾請另外填寫');
    const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'skillshub-')));
    try {
      await exec('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--depth', '1', '--', parsed.href, temp], { timeout: 60000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      const selected = path.resolve(temp, subdirectory || '.');
      if (selected !== temp && !selected.startsWith(temp + path.sep)) throw new Error('子資料夾必須位於儲存庫內');
      const resolved = await fs.realpath(selected);
      if (resolved !== temp && !resolved.startsWith(temp + path.sep)) throw new Error('子資料夾不可連結到儲存庫外');
      const { stdout } = await exec('git', ['-C', temp, 'rev-parse', 'HEAD']);
      return await this.importLocal(resolved, { type: 'github', location: parsed.href, revision: stdout.trim(), checkout: temp });
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  update(id, patch) {
    const s = this.skill(id);
    for (const key of ['summary', 'useCase']) {
      if (key in patch) {
        if (typeof patch[key] !== 'string' || patch[key].length > 2000) throw new Error('用途摘要必須是 2,000 字以內的文字');
        s[key] = patch[key].trim();
      }
    }
    if (typeof patch.favorite === 'boolean') s.favorite = patch.favorite;
    if (typeof patch.notes === 'string') s.notes = patch.notes.slice(0, 10000);
    if (Array.isArray(patch.tags)) s.tags = [...new Set(patch.tags.filter(t => typeof t === 'string').map(t => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
    return s;
  }
  savePack(input) {
    if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('套組名稱需為 1–80 字');
    if (typeof input.purpose !== 'string' || input.purpose.length > 5000) throw new Error('套組用途需為 5,000 字以內的文字');
    if (!Array.isArray(input.members) || input.members.length > 300) throw new Error('套組最多可包含 300 個 Skills');
    const seen = new Set();
    const members = input.members.map(member => {
      if (!member || typeof member.skillId !== 'string' || typeof member.reason !== 'string' || member.reason.length > 2000) throw new Error('套組成員與使用提示格式不正確');
      this.skill(member.skillId);
      if (seen.has(member.skillId)) throw new Error('套組成員不可重複');
      seen.add(member.skillId);
      return { skillId: member.skillId, reason: member.reason.trim() };
    });
    const now = new Date().toISOString();
    let record;
    if (input.id) {
      record = this.db.packs.find(p => p.id === input.id);
      if (!record) throw new Error('找不到套組');
      if (record.revision !== input.revision) throw new Error('套組已在其他頁面更新。請重新整理後再編輯，避免覆蓋變更。');
    } else {
      record = { id: randomUUID(), createdAt: now, revision: 0 };
      this.db.packs.push(record);
    }
    Object.assign(record, { name: input.name.trim(), purpose: input.purpose.trim(), members, updatedAt: now, revision: record.revision + 1 });
    return record;
  }
  deletePack(id, revision) {
    if ((this.db.packDeployments || []).some(d => d.packId === id)) throw new Error('此套組仍有工具配置，請先在工具配置中預覽並解除套組配置');
    const index = this.db.packs.findIndex(p => p.id === id);
    if (index < 0) throw new Error('找不到套組');
    if (this.db.packs[index].revision !== revision) throw new Error('套組已更新，請重新整理後再刪除');
    this.db.packs.splice(index, 1);
    return { deleted: id };
  }
  async target(tool, scope, project) {
    if (!['codex', 'claude'].includes(tool)) throw new Error('不支援的工具');
    if (!['user', 'project'].includes(scope)) throw new Error('不支援的安裝範圍');
    let base = this.home;
    if (scope === 'project') {
      if (typeof project !== 'string' || !path.isAbsolute(expand(project))) throw new Error('請輸入專案的絕對路徑');
      base = await fs.realpath(expand(project));
      if (!(await fs.stat(base)).isDirectory()) throw new Error('專案必須是既有資料夾');
    }
    const target = path.join(base, tool === 'codex' ? '.agents' : '.claude', 'skills');
    // Do not follow a redirected target directory when writing installations.
    let check = base;
    for (const part of path.relative(base, target).split(path.sep)) {
      check = path.join(check, part);
      if (await exists(check) && (await fs.lstat(check)).isSymbolicLink()) throw new Error(`安裝目錄不可為符號連結：${check}`);
    }
    return target;
  }
  async projectPath(input) {
    if (typeof input !== 'string' || !path.isAbsolute(expand(input.trim()))) throw new Error('請選擇專案資料夾');
    const location = await fs.realpath(expand(input.trim()));
    if (!(await fs.stat(location)).isDirectory()) throw new Error('請選擇資料夾');
    return location;
  }
  async browseFolders(input) {
    const location = await this.projectPath(input || this.home);
    const entries = await fs.readdir(location, { withFileTypes: true });
    const folders = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(location, entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && await fs.stat(full).then(s => s.isDirectory()).catch(() => false))) folders.push({ name: entry.name, path: full });
    }
    return { path: location, parent: path.dirname(location), home: this.home, folders: folders.sort((a,b) => a.name.localeCompare(b.name)) };
  }
  async addProject(input) {
    const location = await this.projectPath(input);
    const existing = this.db.projects.find(p => p.path === location);
    if (existing) return existing;
    const project = { id: randomUUID(), name: path.basename(location) || location, path: location };
    this.db.projects.push(project);
    return project;
  }
  removeProject(id) {
    if (!this.db.projects.some(p => p.id === id)) throw new Error('找不到專案');
    this.db.projects = this.db.projects.filter(p => p.id !== id);
    return { removed: id };
  }
  async projectConfiguration(tool, project) {
    const target = await this.target(tool, 'project', project);
    const result = { tool, project: path.dirname(path.dirname(target)), target, exists: await exists(target), items: [] };
    if (!result.exists) return result;
    const entries = await fs.readdir(target, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const destination = path.join(target, entry.name);
      const item = { name: entry.name, destination, status: 'unreadable', message: '' };
      try {
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('非一般 Skill 資料夾，未讀取');
        const meta = await this.metadata(destination);
        item.name = meta.name;
        const digest = await this.fingerprint(destination);
        const candidates = this.db.skills.filter(s => s.name === meta.name);
        item.status = candidates.some(s => s.digest === digest) ? 'current' : candidates.length ? 'different' : 'uncollected';
      } catch (error) { item.message = error.message; }
      result.items.push(item);
    }
    return result;
  }
  async installationTargets(ids,packId) { return installationTargets(this,ids,packId); }
  async plan(ids, tool, scope, project, linkExisting = false) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 300) throw new Error('請選擇 1–300 個 Skill');
    const target = await this.target(tool, scope, project);
    const selected = [...new Set(ids)].map(id => this.skill(id));
    const items = [];
    for (const s of selected) {
      const id = s.id, destination = path.join(target, s.name);
      const unsupported = tool === 'claude' && ['synced', 'anthropic-skills'].includes(s.name);
      const sourceDigest = await this.fingerprint(this.folder(id));
      let action = 'add', message = '新增完整 Skill 資料夾', destinationDigest = null, strictDigest = null, changes = [];
      const managed = (this.db.managedInstalls || []).find(r=>r.destination===destination);
      if (await exists(destination)) {
        try {
          const stat = await fs.lstat(destination);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('不是一般目錄');
          destinationDigest = await this.fingerprint(destination);
          strictDigest = await this.fingerprint(destination,true);
          action = destinationDigest === sourceDigest ? 'same' : 'conflict';
          message = action === 'same' ? '相同內容已存在，略過' : '同名但內容不同，保留原檔';
        } catch { action = 'conflict'; message = '目標已存在且無法安全比對，保留原檔'; }
      }
      const managedId = managed?.skillId || this.db.installs.find(r=>r.destination===destination && r.digest===managed?.digest)?.skillId;
      const otherVersion = (this.db.packDeployments || []).some(d=>d.target===target && d.members.some(m=>m.name===s.name && m.skillId!==id));
      if (action==='conflict' && !otherVersion && strictDigest && ((managedId===id && strictDigest===managed?.strictDigest) || (linkExisting && !managed && (s.previousDigests || []).includes(strictDigest))) && sourceDigest===s.digest) {
        action='update'; message='已管理的舊版且未被修改；備份後更新為收藏版本';
        changes=await fileChanges(this,destination,this.folder(id));
      }
      if (linkExisting && action==='same' && !managed && strictDigest===sourceDigest) { action='link';message='內容一致；確認後加入同步，之後可隨此安裝更新或移除'; }
      if (selected.filter(x => x.name === s.name).length > 1) { action = 'conflict'; message = '同時選取同名的不同版本，請只選擇一個版本'; }
      if (sourceDigest !== s.digest) { action = 'conflict'; message = '收藏檔案已變更，請重新收錄後再安裝'; }
      if (unsupported) { action = 'conflict'; message = '此名稱為目標工具保留名稱'; }
      items.push({ id, name: s.name, destination, action, message, sourceDigest, destinationDigest, strictDigest, changes, managed: managed || null, conflict: action === 'conflict', unsupported });
    }
    return { tool, scope, target, items };
  }
  async previewRemoval(id) { return previewRemoval(this,id); }
  async confirmRemoval(token) { return confirmRemoval(this,token); }
  async previewAdoption(input) { await prunePreviews(this); return previewAdoption(this,input); }
  async confirmAdoption(token, ids) { return confirmAdoption(this,token,ids); }
  async previewSourceUpdate(id) { return previewSourceUpdate(this,id); }
  async confirmSourceUpdate(token) { return confirmSourceUpdate(this,token); }
  async previewInstall(ids, tool, scope, project, packId = null, detach = false, linkExisting = false) {
    const plan = packId ? await planSync(this, packId, tool, scope, project, detach, linkExisting) : await this.plan(ids, tool, scope, project, linkExisting);
    ids = packId ? plan.ids : ids;
    await prunePreviews(this);
    const token = randomUUID(), expiresAt = Date.now() + 10 * 60 * 1000;
    this.previews.set(token, { ids: [...ids], tool, scope, project, packId, detach, linkExisting, plan: structuredClone(plan), expiresAt });
    return { ...plan, canApply: packId ? true : plan.items.some(i => i.action !== 'conflict'), token, expiresAt };
  }
  async confirmInstall(token) {
    const entry = this.previews.get(token);
    if (!entry || entry.kind || entry.expiresAt <= Date.now()) { if (!entry?.kind) this.previews.delete(token); throw new Error('安裝預覽已失效，請重新預覽'); }
    this.previews.delete(token);
    if (entry.packId) return confirmSync(this, entry);
    const current = await this.plan(entry.ids, entry.tool, entry.scope, entry.project, entry.linkExisting);
    if (JSON.stringify(current) !== JSON.stringify(entry.plan)) throw new Error('來源或目標在預覽後已變更，請重新預覽再安裝');
    return this.install(entry.ids, entry.tool, entry.scope, entry.project, 'individual', entry.linkExisting);
  }
  async install(ids, tool, scope, project, owner = 'individual', linkExisting = false) {
    const plan = await this.plan(ids, tool, scope, project, linkExisting), results = [];
    for (const item of plan.items) {
      if (item.action==='link') {
        await noteOwnership(this,item,owner,true);
        this.db.installs=this.db.installs.filter(r=>r.destination!==item.destination);
        this.db.installs.push({id:randomUUID(),skillId:item.id,tool,scope,destination:item.destination,digest:item.sourceDigest,installedAt:new Date().toISOString()});
        results.push({...item,status:'linked',message:'已加入同步，檔案未修改'});continue;
      }
      if (!['add','update'].includes(item.action)) { if (item.action === 'same') await noteOwnership(this, item, owner); results.push({ ...item, status: 'skipped' }); continue; }
      let created = false, backup;
      try {
        await fs.mkdir(plan.target, { recursive: true });
        if (item.action === 'update') {
          await this.target(tool,scope,project);
          if (await this.fingerprint(item.destination,true) !== item.strictDigest) throw new Error('目標內容已變更，請重新預覽');
          const backupRoot = path.join(plan.target,'.skillshub-recovery');
          if (await exists(backupRoot) && (await fs.lstat(backupRoot)).isSymbolicLink()) throw new Error('備份目錄不可為符號連結');
          const dir=path.join(backupRoot,randomUUID());backup=path.join(dir,item.name);
          await fs.mkdir(dir,{recursive:true});
          await fs.writeFile(path.join(dir,'restore.json'),JSON.stringify({original:item.destination,backup,at:new Date().toISOString()},null,2));
          await fs.rename(item.destination,backup);
          this.rollbackOperations?.push(async()=>{await fs.rm(item.destination,{recursive:true,force:true});await fs.rename(backup,item.destination);});
          if (await this.fingerprint(backup,true)!==item.strictDigest) throw new Error('更新時目標內容變更，已取消');
        }
        await fs.mkdir(item.destination); created = true;
        this.rollbackOperations?.push(() => fs.rm(item.destination, { recursive: true, force: true }));
        await this.copy(this.folder(item.id), item.destination);
        const digest = await this.fingerprint(item.destination);
        if (digest !== item.sourceDigest) throw new Error('來源內容變更，請重新預覽');
        this.db.installs = this.db.installs.filter(r => r.destination !== item.destination);
        this.db.installs.push({ id: randomUUID(), skillId: item.id, tool, scope, destination: item.destination, digest, installedAt: new Date().toISOString() });
        const effectiveOwner = item.action==='update' && owner==='individual' && item.managed?.owners.length ? item.managed.owners[0] : owner;
        await noteOwnership(this, item, effectiveOwner, true);
        results.push({ ...item, status: item.action==='update' ? 'updated' : 'installed', backup, message: backup ? `已更新；舊版備份：${backup}` : item.message });
      } catch (e) {
        if (item.action==='update') throw e;
        if (created) await fs.rm(item.destination, { recursive: true, force: true });
        results.push({ ...item, status: 'error', message: e.message });
      }
    }
    return results;
  }
  async list() {
    const targets = { codex: path.join(this.home, '.agents', 'skills'), claude: path.join(this.home, '.claude', 'skills') };
    const projectRoots=[];
    for(const p of this.db.projects)for(const tool of ['codex','claude'])try{projectRoots.push({tool,project:p.path,target:await this.target(tool,'project',p.path)});}catch{}
    const skills = await Promise.all(this.db.skills.map(async s => {
      const locations = [];
      for (const [tool, root] of Object.entries(targets)) {
        const destination = path.join(root, s.name);
        if (await exists(destination)) {
          let same = false;
          try { same = await this.fingerprint(destination) === s.digest; } catch {}
          locations.push({ tool, scope: 'user', destination, status: same ? 'current' : 'different' });
        }
      }
      for (const record of this.db.installs.filter(r => r.skillId === s.id && r.scope === 'project')) {
        let status = 'missing';
        if (await exists(record.destination)) { try { status = await this.fingerprint(record.destination) === s.digest ? 'current' : 'different'; } catch { status = 'different'; } }
        locations.push({ ...record, status });
      }
      for(const p of projectRoots) {
        const destination=path.join(p.target,s.name);if(locations.some(i=>i.destination===destination) || !(await exists(destination)))continue;
        let status='different';try{status=await this.fingerprint(destination)===s.digest?'current':'different';}catch{}
        locations.push({tool:p.tool,scope:'project',project:p.project,destination,status});
      }
      return { ...s, installations: locations };
    }));
    const detachedInstalls = await Promise.all(this.db.installs.filter(r=>!this.db.skills.some(s=>s.id===r.skillId)).map(async r=>({...r,name:r.name || path.basename(r.destination),status:await exists(r.destination)?'uncollected':'missing'})));
    return { skills, detachedInstalls, packs: this.db.packs, deployments: this.db.packDeployments || [], projects: this.db.projects, targets, suggestedImport: targets.codex };
  }
  async detail(id) {
    const s = this.skill(id);
    return { ...s, ...(await this.metadata(this.folder(id))), files: await this.tree(this.folder(id)) };
  }
}
