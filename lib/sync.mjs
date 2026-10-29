import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const exists = async p => fs.lstat(p).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
export async function noteOwnership(store, item, owner, created = false) {
  store.db.managedInstalls ||= [];
  let record = store.db.managedInstalls.find(r => r.destination === item.destination);
  if (created) {
    store.db.managedInstalls = store.db.managedInstalls.filter(r => r.destination !== item.destination);
    const owners = new Set(record?.owners || []);
    for (const d of store.db.packDeployments || []) if (d.target === path.dirname(item.destination) && d.members.some(m => m.name === item.name)) owners.add(`pack:${d.packId}`);
    record = { destination: item.destination, skillId: item.id, digest: item.sourceDigest, strictDigest: await store.fingerprint(item.destination, true), owners: [...owners] };
    store.db.managedInstalls.push(record);
  }
  // Matching pre-existing files without provenance are never adopted for deletion.
  if (record && record.digest === item.sourceDigest && !record.owners.includes(owner)) record.owners.push(owner);
}

export async function planSync(store, packId, tool, scope, project, detach = false, linkExisting = false) {
  const target = await store.target(tool, scope, project);
  const previous = (store.db.packDeployments || []).find(d => d.packId === packId && d.target === target);
  const pack = store.db.packs.find(p => p.id === packId);
  if (!pack && !previous) throw new Error('找不到套組或安裝紀錄');
  if (detach && !previous) throw new Error('此目標沒有可解除的套組配置');
  const ids = detach ? [] : pack?.members.map(m => m.skillId);
  if (!ids) throw new Error('套組不存在，請解除舊配置');
  const plan = ids.length ? await store.plan(ids, tool, scope, project, linkExisting) : { tool, scope, target, items: [] };
  const owner = `pack:${packId}`, desiredNames = new Set(plan.items.map(i => i.name));
  for (const member of new Map((previous?.members || []).map(m => [m.name, m])).values()) {
    if (desiredNames.has(member.name)) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(member.name)) throw new Error('安裝紀錄名稱不合法');
    const destination = path.join(target, member.name);
    const managed = (store.db.managedInstalls || []).find(r => r.destination === destination);
    let action = 'keep', message = '來源不明或舊版安裝紀錄，保留原檔', destinationDigest = null;
    if (!(await exists(destination))) message = '目標已不存在，只清除套組關聯';
    else if (managed?.owners.includes(owner)) {
      if (managed.owners.some(o => o !== owner)) message = managed.owners.includes('individual') ? '曾單獨安裝，保留原檔' : '其他套組仍在使用，保留原檔';
      else {
        try {
          const stat = await fs.lstat(destination);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('非一般目錄');
          destinationDigest = await store.fingerprint(destination, true);
          if (destinationDigest !== managed.strictDigest) message = '安裝內容已被修改，保留原檔';
          else { action = 'remove'; message = '此套組已不需要；移出工具目錄並保存還原備份'; }
        } catch { message = '無法安全比對目標內容，保留原檔'; }
      }
    }
    plan.items.push({ id: member.skillId, name: member.name, destination, action, message, destinationDigest });
  }
  return { ...plan, kind: 'sync', linkExisting, packId, packName: pack?.name || previous.packName, packRevision: pack?.revision ?? null, detach,
    ids, previous: previous || null,
    ownership: (store.db.managedInstalls || []).filter(r => path.dirname(r.destination) === target),
    canApply: true, warning: previous || linkExisting ? '' : '第一次追蹤此套組：既有檔案不會被當作可刪除的管理項目。舊版安裝不會自動移除。' };
}

export async function confirmSync(store, entry) {
  const current = await planSync(store, entry.packId, entry.tool, entry.scope, entry.project, entry.detach, entry.linkExisting);
  if (JSON.stringify(current) !== JSON.stringify(entry.plan)) throw new Error('套組、來源、目標或使用關聯已變更，請重新預覽');
  const owner = `pack:${current.packId}`;
  const results = current.ids.length ? await store.install(current.ids, current.tool, current.scope, entry.project, owner, entry.linkExisting) : [];
  // A failed addition must not remove members from the previous working configuration.
  if (results.some(r => r.status === 'error')) throw new Error('新增項目失敗，已取消同步；請重新預覽');
  for (const item of current.items.filter(i => ['remove','keep'].includes(i.action))) {
    if (item.action === 'remove') {
      await store.target(current.tool, current.scope, entry.project);
      const stat = await fs.lstat(item.destination);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await store.fingerprint(item.destination, true) !== item.destinationDigest) throw new Error('待移除內容已變更，請重新預覽');
      const recoveryRoot = path.join(current.target, '.skillshub-recovery');
      if (await exists(recoveryRoot) && (await fs.lstat(recoveryRoot)).isSymbolicLink()) throw new Error('備份目錄不可為符號連結');
      const backupDir = path.join(recoveryRoot, randomUUID()), backup = path.join(backupDir, item.name);
      await fs.mkdir(backupDir, { recursive: true });
      await fs.writeFile(path.join(backupDir, 'restore.json'), JSON.stringify({ original: item.destination, backup, packId: current.packId, at: new Date().toISOString() }, null, 2), { flag: 'wx' });
      await fs.rename(item.destination, backup);
      store.rollbackOperations?.push(async () => { if (!(await exists(item.destination))) await fs.rename(backup, item.destination); });
      if (await store.fingerprint(backup, true) !== item.destinationDigest) throw new Error('移除時內容發生變更，已取消同步');
      store.db.installs = store.db.installs.filter(r => r.destination !== item.destination);
      store.db.managedInstalls = (store.db.managedInstalls || []).filter(r => r.destination !== item.destination);
      results.push({ ...item, status: 'removed', message: `已移出工具目錄；還原備份：${backup}`, backup });
    } else {
      const record = (store.db.managedInstalls || []).find(r => r.destination === item.destination);
      if (record) record.owners = record.owners.filter(o => o !== owner);
      results.push({ ...item, status: 'skipped' });
    }
  }
  store.db.packDeployments ||= [];
  store.db.packDeployments = store.db.packDeployments.filter(d => !(d.packId === current.packId && d.target === current.target));
  if (!current.detach) store.db.packDeployments.push({ packId: current.packId, packName: current.packName, revision: current.packRevision, conflicts: current.items.filter(i=>i.action==='conflict').length, tool: current.tool, scope: current.scope,
    project: current.scope === 'project' ? path.dirname(path.dirname(current.target)) : '', target: current.target,
    members: current.ids.map(id => { const s = store.skill(id); return { skillId: id, name: s.name }; }), updatedAt: new Date().toISOString() });
  return results;
}
