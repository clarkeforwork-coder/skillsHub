import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SkillStore } from '../lib/store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-packs-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = { skills: [
    { id: 'one', name: 'research', notes: '原有筆記', tags: ['研究'], favorite: true },
    { id: 'two', name: 'review', notes: '', tags: [], favorite: false }
  ], installs: [{ skillId: 'one', destination: '/existing/installation' }] };
  await fs.writeFile(path.join(root, 'catalog.json'), JSON.stringify(legacy));
  const store = await new SkillStore(root).init();
  return { root, store, legacy };
}
const draft = () => ({ name: '研究與審查', purpose: '查證資料並檢查變更', members: [{ skillId: 'one', reason: '先研究' }, { skillId: 'two', reason: '再審查' }] });

test('legacy migration preserves all metadata and installs, backs up original without seeding demo packs', async t => {
  const { root, store, legacy } = await fixture(t);
  assert.deepEqual(store.db.skills, legacy.skills);
  assert.deepEqual(store.db.installs, legacy.installs);
  assert.deepEqual(store.db.packs, []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'catalog.before-v2.json'), 'utf8')), legacy);
  await store.mutate(() => store.update('one', { summary: '資料研究', useCase: '決策前查證', notes: '新的筆記', tags: ['研究', '常用'] }));
  const restarted = await new SkillStore(root).init();
  assert.equal(restarted.skill('one').summary, '資料研究');
  assert.equal(restarted.skill('one').useCase, '決策前查證');
  assert.equal(restarted.skill('one').favorite, true);
  assert.deepEqual(restarted.db.installs, legacy.installs);
});

test('pack creation, member order, prompts, rename and removal survive restart', async t => {
  const { root, store } = await fixture(t);
  const p = structuredClone(await store.mutate(() => store.savePack(draft())));
  const next = { ...p, name: '新名稱', members: [...p.members].reverse() };
  next.members[0].reason = '新的提示';
  const saved = await store.mutate(() => store.savePack(next));
  let restarted = await new SkillStore(root).init();
  assert.equal(restarted.db.packs[0].name, '新名稱');
  assert.deepEqual(restarted.db.packs[0].members, [{ skillId: 'two', reason: '新的提示' }, { skillId: 'one', reason: '先研究' }]);
  await store.mutate(() => store.savePack({ ...saved, members: saved.members.slice(0, 1) }));
  restarted = await new SkillStore(root).init();
  assert.equal(restarted.db.packs[0].members.length, 1);
  assert.equal(restarted.db.skills.length, 2);
});

test('rejects unknown/duplicate references and invalid fields without partially saving', async t => {
  const { root, store } = await fixture(t);
  for (const input of [
    { ...draft(), name: ' ' },
    { ...draft(), purpose: null },
    { ...draft(), members: [{ skillId: 'missing', reason: '' }] },
    { ...draft(), members: [draft().members[0], draft().members[0]] },
    { ...draft(), members: [{ skillId: 'one', reason: null }] }
  ]) await assert.rejects(store.mutate(() => store.savePack(input)));
  assert.equal(store.db.packs.length, 0);
  const restart = await new SkillStore(root).init();
  assert.equal(restart.db.packs.length, 0);
});

test('stale updates/deletes fail while independent concurrent creations are preserved', async t => {
  const { store } = await fixture(t);
  const results = await Promise.all([store.mutate(() => store.savePack(draft())), store.mutate(() => store.savePack({ ...draft(), name: '另一套組' }))]);
  assert.equal(store.db.packs.length, 2);
  const stale = structuredClone(results[0]);
  await store.mutate(() => store.savePack({ ...stale, name: '最新名稱' }));
  await assert.rejects(store.mutate(() => store.savePack({ ...stale, name: '過時名稱' })), /其他頁面更新/);
  await assert.rejects(store.mutate(() => store.deletePack(stale.id, stale.revision)), /已更新/);
  assert.equal(store.db.packs[0].name, '最新名稱');
});

test('deleting a pack retains skills and installation records', async t => {
  const { root, store, legacy } = await fixture(t);
  const p = await store.mutate(() => store.savePack(draft()));
  await store.mutate(() => store.deletePack(p.id, p.revision));
  const restarted = await new SkillStore(root).init();
  assert.deepEqual(restarted.db.packs, []);
  assert.deepEqual(restarted.db.skills, legacy.skills);
  assert.deepEqual(restarted.db.installs, legacy.installs);
});

test('failed writes restore in-memory state and remain retryable', async t => {
  const { root, store } = await fixture(t);
  const original = structuredClone(store.db);
  const target = path.join(root, 'catalog.json');
  await fs.rename(target, target + '.saved');
  await fs.mkdir(target); // Force atomic rename to fail.
  await assert.rejects(store.mutate(() => store.savePack(draft())));
  assert.deepEqual(store.db, original);
  await fs.rmdir(target);
  await fs.rename(target + '.saved', target);
  await store.mutate(() => store.savePack(draft()));
  assert.equal((await new SkillStore(root).init()).db.packs.length, 1);
});
