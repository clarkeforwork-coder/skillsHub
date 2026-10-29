import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { noteOwnership } from './sync.mjs';

export async function adoptionPlan(store, input) {
  const pack = store.db.packs.find(p => p.id === input.packId);
  if (!pack?.members.length) throw new Error('請選擇有成員的套組');
  const plan = await store.plan(pack.members.map(m => m.skillId), input.tool, input.scope, input.project);
  for (const item of plan.items) {
    item.eligible = false;
    if (item.action === 'same') {
      try {
        item.strictDigest = await store.fingerprint(item.destination, true);
        item.eligible = item.strictDigest === await store.fingerprint(store.folder(item.id), true);
      } catch {}
    }
    item.message = item.eligible ? '與收藏完整一致，可由你確認後納入套組管理' : item.action === 'add' ? '尚未安裝，請使用安裝／同步' : '內容不同、含額外檔案或無法比對，不可認領';
  }
  return { ...plan, packId: pack.id, packName: pack.name, revision: pack.revision,
    previous: (store.db.packDeployments || []).find(d => d.packId === pack.id && d.target === plan.target) || null,
    ownership: (store.db.managedInstalls || []).filter(r => path.dirname(r.destination) === plan.target) };
}
export async function previewAdoption(store, input) {
  const plan = await adoptionPlan(store, input), token = randomUUID();
  store.previews.set(token, { kind: 'adoption', input: structuredClone(input), plan: structuredClone(plan), expiresAt: Date.now() + 600000 });
  return { ...plan, token };
}
export async function confirmAdoption(store, token, ids) {
  const entry = store.previews.get(token);
  if (entry?.kind === 'adoption') store.previews.delete(token);
  if (!entry || entry.kind !== 'adoption' || entry.expiresAt <= Date.now()) throw new Error('認領預覽已失效，請重新預覽');
  const plan = await adoptionPlan(store, entry.input);
  if (JSON.stringify(plan) !== JSON.stringify(entry.plan)) throw new Error('內容、套組或關聯已變更，請重新預覽');
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !plan.items.some(i => i.id === id && i.eligible))) throw new Error('請勾選可認領的項目');
  const selected = plan.items.filter(i => ids.includes(i.id));
  for (const item of selected) {
    await noteOwnership(store, item, `pack:${plan.packId}`, true);
    store.db.installs = store.db.installs.filter(r => r.destination !== item.destination);
    store.db.installs.push({ id: randomUUID(), skillId: item.id, tool: plan.tool, scope: plan.scope, destination: item.destination, digest: item.sourceDigest, installedAt: new Date().toISOString(), adopted: true });
  }
  store.db.packDeployments ||= [];
  const previous = plan.previous;
  store.db.packDeployments = store.db.packDeployments.filter(d => !(d.packId === plan.packId && d.target === plan.target));
  const members = new Map((previous?.members || []).map(m => [m.name, m]));
  for (const item of selected) members.set(item.name, {skillId:item.id,name:item.name});
  store.db.packDeployments.push({ packId:plan.packId,packName:plan.packName,revision:plan.revision,tool:plan.tool,scope:plan.scope,
    project:plan.scope === 'project' ? path.dirname(path.dirname(plan.target)) : '',target:plan.target,members:[...members.values()],updatedAt:new Date().toISOString() });
  return { adopted: selected.length };
}
