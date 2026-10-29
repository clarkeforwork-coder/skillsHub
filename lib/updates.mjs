import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function prunePreviews(store) {
  for (const [token, entry] of store.previews) {
    if (entry.expiresAt > Date.now() && store.previews.size < 100) continue;
    store.previews.delete(token);
    if (entry.staging) await fs.rm(entry.staging, {recursive:true,force:true});
  }
}
export async function fileChanges(store, before, after) {
  const oldFiles = await store.tree(before), newFiles = await store.tree(after), result = [];
  for (const name of new Set([...oldFiles, ...newFiles])) {
    const action = !oldFiles.includes(name) ? 'add' : !newFiles.includes(name) ? 'remove' : !(await fs.readFile(path.join(before,name))).equals(await fs.readFile(path.join(after,name))) ? 'update' : null;
    if (action) result.push({name,action});
  }
  return result;
}
export async function previewSourceUpdate(store, id) {
  await prunePreviews(store);
  const skill = structuredClone(store.skill(id));
  const base = await store.fingerprint(store.folder(id),true);
  if (base !== (skill.strictDigest || skill.digest)) throw new Error('私人收藏內容已被手動修改，保留原檔；請先另行收錄或處理差異');
  const staging = path.join(store.root,'staging',randomUUID());
  try {
    const temp = await new store.constructor(staging,store.home).init();
    const result = skill.source.type === 'github' ? await temp.importGitHub(skill.source.location,skill.source.subdirectory) : skill.source.type === 'local' ? await temp.importLocal(skill.source.location) : null;
    if (!result || result.some(r=>r.status==='error') || temp.db.skills.length !== 1 || temp.db.skills[0].name !== skill.name) throw new Error('來源已移動、名稱改變或無法讀取；不會自動替換收藏');
    const next = temp.db.skills[0], snapshot = temp.folder(next.id);
    const changes = await fileChanges(store,store.folder(id),snapshot);
    const token = randomUUID(), plan = {id,name:skill.name,source:next.source,oldRevision:skill.source.revision || '',before:skill.digest,after:next.digest,changes,canApply:changes.length > 0};
    store.previews.set(token,{kind:'source',staging,snapshot,base,source:skill.source,next,plan,expiresAt:Date.now()+600000});
    return {...plan,token};
  } catch (error) { await fs.rm(staging,{recursive:true,force:true}); throw error; }
}
export async function confirmSourceUpdate(store, token) {
  const entry = store.previews.get(token);
  if (!entry || entry.kind !== 'source') throw new Error('來源更新預覽已失效，請重新檢查');
  store.previews.delete(token);
  try {
    if (entry.expiresAt <= Date.now()) throw new Error('來源更新預覽已失效，請重新檢查');
    const skill = store.skill(entry.plan.id), destination = store.folder(skill.id);
    if (JSON.stringify(skill.source) !== JSON.stringify(entry.source) || skill.digest !== entry.plan.before || await store.fingerprint(destination,true) !== entry.base || await store.fingerprint(entry.snapshot,true) !== entry.next.digest) throw new Error('收藏或更新快照已變更，請重新預覽');
    if (!entry.plan.canApply) throw new Error('來源內容沒有變更');
    const backupDir = path.join(store.root,'recovery',randomUUID()), backup = path.join(backupDir,skill.id);
    await fs.mkdir(backupDir,{recursive:true});
    await fs.writeFile(path.join(backupDir,'restore.json'),JSON.stringify({original:destination,backup,metadata:skill,at:new Date().toISOString()},null,2));
    await fs.rename(destination,backup);
    store.rollbackOperations.push(async()=>{await fs.rm(destination,{recursive:true,force:true});await fs.rename(backup,destination);});
    await fs.mkdir(destination);await store.copy(entry.snapshot,destination);
    if (await store.fingerprint(destination,true) !== entry.next.digest) throw new Error('更新複製內容不完整，已取消');
    skill.previousDigests=[...new Set([...(skill.previousDigests || []),entry.base])];
    Object.assign(skill,{description:entry.next.description,digest:entry.next.digest,strictDigest:entry.next.digest,source:entry.next.source,updatedAt:new Date().toISOString()});
    return {id:skill.id,backup,changes:entry.plan.changes.length};
  } finally { await fs.rm(entry.staging,{recursive:true,force:true}); }
}
