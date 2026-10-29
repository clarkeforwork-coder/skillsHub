import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillStore } from '../lib/store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillshub-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), home = path.join(root, 'home');
  await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
  await fs.mkdir(home);
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: test-skill\ndescription: >-\n  A useful skill\n  with multiple lines.\n---\n\n# Instructions\n');
  await fs.writeFile(path.join(source, 'scripts', 'run.sh'), '#!/bin/sh\necho example\n', { mode: 0o755 });
  const store = await new SkillStore(path.join(root, 'data'), home).init();
  const importSkill = async () => { await store.mutate(() => store.importLocal(source)); return store.db.skills[0].id; };
  return { root, source, home, store, importSkill };
}

test('imports full bundles, parses YAML and persists metadata through restart', async t => {
  const { store, source, importSkill } = await fixture(t), id = await importSkill();
  const detail = await store.detail(id);
  assert.equal(detail.description, 'A useful skill with multiple lines.');
  assert.deepEqual(detail.files, ['SKILL.md', 'scripts/run.sh']);
  await fs.writeFile(path.join(source, 'scripts', 'run.sh'), 'source changed');
  assert.match(await fs.readFile(path.join(store.folder(id), 'scripts', 'run.sh'), 'utf8'), /echo example/);
  await store.mutate(() => store.update(id, { notes: '中文筆記', tags: ['常用', '常用'], favorite: true }));
  const restarted = await new SkillStore(store.root, store.home).init();
  assert.deepEqual(restarted.skill(id).tags, ['常用']);
  assert.equal(restarted.skill(id).notes, '中文筆記');
  assert.equal(restarted.skill(id).favorite, true);
});

test('deduplicates identical content and preserves different versions', async t => {
  const { store, source, importSkill } = await fixture(t); await importSkill();
  const duplicate = await store.mutate(() => store.importLocal(source));
  assert.equal(duplicate[0].status, 'skipped');
  await fs.appendFile(path.join(source, 'SKILL.md'), '\nNew version');
  await store.mutate(() => store.importLocal(source));
  assert.equal(store.db.skills.length, 2);
});

test('installs both tool scopes, retains scripts and refuses overwrite', async t => {
  const { store, root, home, importSkill } = await fixture(t), id = await importSkill();
  const first = await store.mutate(() => store.install([id], 'codex', 'user'));
  assert.equal(first[0].status, 'installed');
  assert.equal(first[0].destination, path.join(home, '.agents', 'skills', 'test-skill'));
  assert.ok((await fs.stat(path.join(first[0].destination, 'scripts', 'run.sh'))).mode & 0o100);
  await fs.appendFile(path.join(first[0].destination, 'SKILL.md'), '\nUser edit');
  const again = await store.mutate(() => store.install([id], 'codex', 'user'));
  assert.equal(again[0].status, 'skipped');
  assert.match(await fs.readFile(path.join(first[0].destination, 'SKILL.md'), 'utf8'), /User edit/);
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const claude = await store.mutate(() => store.install([id], 'claude', 'project', project));
  assert.equal(claude[0].destination, path.join(await fs.realpath(project), '.claude', 'skills', 'test-skill'));
  const list = await store.list();
  assert.equal(list.skills[0].installations.find(i => i.tool === 'codex').status, 'different');
  assert.equal(list.skills[0].installations.find(i => i.tool === 'claude').status, 'current');
});

test('rejects traversal names and symlink files before copying', async t => {
  const { store, source } = await fixture(t);
  const original = await fs.readFile(path.join(source, 'SKILL.md'), 'utf8');
  await fs.writeFile(path.join(source, 'SKILL.md'), original.replace('test-skill', '../../outside'));
  assert.equal((await store.mutate(() => store.importLocal(source)))[0].status, 'error');
  await fs.writeFile(path.join(source, 'SKILL.md'), original);
  await fs.symlink('/etc/hosts', path.join(source, 'linked-secret'));
  assert.equal((await store.mutate(() => store.importLocal(source)))[0].status, 'error');
  assert.equal(store.db.skills.length, 0);
});

test('rejects symlink target directories and invalid tools/scopes', async t => {
  const { store, root, home, importSkill } = await fixture(t), id = await importSkill();
  await fs.symlink(root, path.join(home, '.agents'));
  await assert.rejects(store.install([id], 'codex', 'user'), /符號連結/);
  await assert.rejects(store.plan([id], 'other', 'user'), /不支援/);
  await assert.rejects(store.plan([id], 'claude', 'unknown'), /不支援/);
  await assert.rejects(store.plan([id], 'claude', 'project', 'relative'), /絕對路徑/);
});

test('serializes imports and skips colliding names in the same batch', async t => {
  const { store, source } = await fixture(t);
  await Promise.all([store.mutate(() => store.importLocal(source)), store.mutate(() => store.importLocal(source))]);
  assert.equal(store.db.skills.length, 1);
  await fs.appendFile(path.join(source, 'SKILL.md'), '\nChanged');
  await store.mutate(() => store.importLocal(source));
  const results = await store.mutate(() => store.install(store.db.skills.map(s => s.id), 'claude', 'user'));
  assert.deepEqual(results.map(r => r.status), ['skipped', 'skipped']);
});

test('GitHub imports reject non-GitHub URLs and embedded credentials', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.importGitHub('file:///etc'), /GitHub/);
  await assert.rejects(store.importGitHub('https://user:pass@github.com/example/repo'), /GitHub/);
  await assert.rejects(store.importGitHub('https://github.com/example/repo/tree/main'), /GitHub/);
});

test('preview distinguishes new, identical and changed targets without writing directories', async t => {
  const { store, home, importSkill } = await fixture(t), id = await importSkill();
  let plan = await store.previewInstall([id], 'claude', 'user');
  assert.equal(plan.items[0].action, 'add');
  await assert.rejects(fs.stat(path.join(home, '.claude')), { code: 'ENOENT' });
  const result = await store.mutate(() => store.confirmInstall(plan.token));
  assert.equal(result[0].status, 'installed');
  plan = await store.previewInstall([id], 'claude', 'user');
  assert.equal(plan.items[0].action, 'same');
  const skipped = await store.mutate(() => store.confirmInstall(plan.token));
  assert.equal(skipped[0].status, 'skipped');
  await fs.appendFile(path.join(plan.items[0].destination, 'SKILL.md'), '\nLocal modification');
  plan = await store.previewInstall([id], 'claude', 'user');
  assert.equal(plan.items[0].action, 'conflict');
  await store.mutate(() => store.confirmInstall(plan.token));
  assert.match(await fs.readFile(path.join(plan.items[0].destination, 'SKILL.md'), 'utf8'), /Local modification/);
});

test('all tool and scope combinations persist complete installation records', async t => {
  const { root, home, store, importSkill } = await fixture(t), id = await importSkill();
  const project = path.join(root, 'project with spaces'); await fs.mkdir(project);
  for (const tool of ['codex', 'claude']) for (const scope of ['user', 'project']) {
    const plan = await store.previewInstall([id], tool, scope, project);
    const result = await store.mutate(() => store.confirmInstall(plan.token));
    assert.equal(result[0].status, 'installed');
    assert.equal(await store.fingerprint(result[0].destination), store.skill(id).digest);
  }
  const restarted = await new SkillStore(store.root, home).init();
  assert.equal(restarted.db.installs.length, 4);
  assert.equal((await restarted.list()).skills[0].installations.length, 4);
});

test('confirmation requires a fresh unconsumed server preview', async t => {
  const { store, importSkill } = await fixture(t), id = await importSkill();
  await assert.rejects(store.mutate(() => store.confirmInstall('forged')), /失效/);
  const plan = await store.previewInstall([id], 'codex', 'user');
  store.previews.get(plan.token).expiresAt = Date.now() - 1;
  await assert.rejects(store.mutate(() => store.confirmInstall(plan.token)), /失效/);
  const next = await store.previewInstall([id], 'codex', 'user');
  await store.mutate(() => store.confirmInstall(next.token));
  await assert.rejects(store.mutate(() => store.confirmInstall(next.token)), /失效/);
});

test('target or source changes after preview prevent stale writes', async t => {
  const { store, importSkill } = await fixture(t), id = await importSkill();
  const plan = await store.previewInstall([id], 'codex', 'user');
  await fs.mkdir(plan.items[0].destination, { recursive: true });
  await fs.writeFile(path.join(plan.items[0].destination, 'sentinel.txt'), 'keep me');
  await assert.rejects(store.mutate(() => store.confirmInstall(plan.token)), /變更/);
  assert.equal(await fs.readFile(path.join(plan.items[0].destination, 'sentinel.txt'), 'utf8'), 'keep me');
  const next = await store.previewInstall([id], 'claude', 'user');
  await fs.appendFile(path.join(store.folder(id), 'SKILL.md'), '\nchanged');
  await assert.rejects(store.mutate(() => store.confirmInstall(next.token)), /變更/);
  await assert.rejects(fs.stat(next.items[0].destination), { code: 'ENOENT' });
});

test('a pack batch installs new items while preserving conflicting files', async t => {
  const { root, store, source, importSkill } = await fixture(t), first = await importSkill();
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: second-skill\ndescription: Second skill\n---\nSecond');
  await store.mutate(() => store.importLocal(source));
  const second = store.db.skills[1].id;
  const p = await store.mutate(() => store.savePack({ name: 'Bundle', purpose: '', members: [{skillId:first,reason:''},{skillId:second,reason:''}] }));
  const project = path.join(root, 'project'); await fs.mkdir(project);
  const existing = path.join(project, '.agents', 'skills', 'test-skill');
  await fs.mkdir(existing, {recursive:true});
  await fs.writeFile(path.join(existing, 'SKILL.md'), 'Personal content');
  const plan = await store.previewInstall(p.members.map(m=>m.skillId), 'codex', 'project', project);
  assert.deepEqual(plan.items.map(i=>i.action), ['conflict','add']);
  const results = await store.mutate(() => store.confirmInstall(plan.token));
  assert.deepEqual(results.map(r=>r.status), ['skipped','installed']);
  assert.equal(await fs.readFile(path.join(existing, 'SKILL.md'), 'utf8'), 'Personal content');
});

test('reads existing project skills without requiring install records or collection membership', async t => {
  const { store, root, source, importSkill } = await fixture(t); await importSkill();
  const project = path.join(root, 'project');
  for (const folder of ['.agents', '.claude']) {
    const target = path.join(project, folder, 'skills');
    await fs.mkdir(target, { recursive: true });
    await fs.cp(source, path.join(target, 'test-skill'), { recursive: true });
    await fs.mkdir(path.join(target, 'private-only'));
    await fs.writeFile(path.join(target, 'private-only', 'SKILL.md'), '---\nname: private-only\ndescription: Project only\n---\n');
  }
  for (const tool of ['codex', 'claude']) {
    const result = await store.projectConfiguration(tool, project);
    assert.equal(result.project, await fs.realpath(project));
    assert.equal(result.items.length, 2);
    assert.equal(result.items.find(i => i.name === 'test-skill').status, 'current');
    assert.equal(result.items.find(i => i.name === 'private-only').status, 'uncollected');
  }
  assert.equal(store.db.installs.length, 0);
  assert.equal(store.db.skills.length, 1);
  await fs.appendFile(path.join(project, '.agents/skills/test-skill/SKILL.md'), '\nEdited');
  assert.equal((await store.projectConfiguration('codex', project)).items.find(i => i.name === 'test-skill').status, 'different');
});

test('project configuration distinguishes absent directories and invalid paths without writing', async t => {
  const { store, root } = await fixture(t);
  const project = path.join(root, 'empty'); await fs.mkdir(project);
  const result = await store.projectConfiguration('codex', project);
  assert.equal(result.exists, false); assert.deepEqual(result.items, []);
  assert.deepEqual(await fs.readdir(project), []);
  await assert.rejects(store.projectConfiguration('codex', path.join(root, 'missing')));
  await assert.rejects(store.projectConfiguration('codex', 'relative/path'));
});

test('multiple saved projects survive restart, deduplicate canonical paths and remove without deleting files', async t => {
  const { store, root } = await fixture(t);
  const a = path.join(root, '專案 A'), b = path.join(root, 'project-b');
  await fs.mkdir(a); await fs.mkdir(b);
  const first = await store.mutate(() => store.addProject(a));
  await store.mutate(() => store.addProject(b));
  const alias = path.join(root, 'alias'); await fs.symlink(a, alias);
  assert.equal((await store.mutate(() => store.addProject(alias))).id, first.id);
  let restarted = await new SkillStore(store.root, store.home).init();
  assert.equal((await restarted.list()).projects.length, 2);
  await restarted.mutate(() => restarted.removeProject(first.id));
  restarted = await new SkillStore(store.root, store.home).init();
  assert.equal(restarted.db.projects.length, 1);
  assert.ok((await fs.stat(a)).isDirectory());
  await assert.rejects(store.mutate(() => store.addProject(path.join(root, 'absent'))));
});

test('folder picker lists directories only and supports parent navigation without writing', async t => {
  const { store, home } = await fixture(t);
  await fs.mkdir(path.join(home, '資料夾'));
  await fs.writeFile(path.join(home, 'file.txt'), 'content');
  const result = await store.browseFolders();
  assert.equal(result.path, await fs.realpath(home));
  assert.deepEqual(result.folders.map(f => f.name), ['資料夾']);
  const child = await store.browseFolders(result.folders[0].path);
  assert.equal(child.parent, result.path);
  assert.deepEqual(child.folders, []);
  await assert.rejects(store.browseFolders(path.join(home, 'file.txt')));
});

test('repository scans discover skills inside agent configuration folders and retain bundled files', async t => {
  const { store, root, source } = await fixture(t);
  const repo = path.join(root, 'repo');
  for (const config of ['.claude', '.agents', '.codex']) {
    const dest = path.join(repo, config, 'skills', 'test-skill');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(source, dest, { recursive: true });
  }
  const ignored = path.join(repo, '.git', 'hidden-skill');
  await fs.mkdir(ignored, { recursive: true });
  await fs.writeFile(path.join(ignored, 'SKILL.md'), '---\nname: ignored\ndescription: Must not import\n---\n');
  const results = await store.mutate(() => store.importLocal(repo));
  assert.equal(results.length, 3);
  assert.equal(results.filter(r => r.status === 'imported').length, 1);
  assert.equal(store.db.skills.length, 1);
  assert.match(await fs.readFile(path.join(store.folder(store.db.skills[0].id), 'scripts/run.sh'), 'utf8'), /echo example/);
});
