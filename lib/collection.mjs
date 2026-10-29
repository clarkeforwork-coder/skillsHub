import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prunePreviews} from './updates.mjs';

async function installationPlan(store,skill,known) {
  const candidates=new Map(known.map(i=>[i.destination,{tool:i.tool,scope:i.scope,destination:i.destination}]));
  for(const project of store.db.projects)for(const tool of ['codex','claude']) {
    const destination=path.join(project.path,tool==='codex'?'.agents':'.claude','skills',skill.name);
    try { await fs.lstat(destination);candidates.set(destination,{tool,scope:'project',destination}); }
    catch(e){if(e.code!=='ENOENT')candidates.set(destination,{tool,scope:'project',destination});}
  }
  const items=[];
  for(const item of candidates.values()) {
    const project=item.scope==='project'?path.dirname(path.dirname(path.dirname(item.destination))):'';
    let action='keep',message='內容不同或無法安全比對，保留檔案',strictDigest=null;
    const managed=(store.db.managedInstalls || []).find(r=>r.destination===item.destination);
    try {
      const target=await store.target(item.tool,item.scope,project);
      if(item.destination!==path.join(target,skill.name))throw new Error('位置不符');
      const stat=await fs.lstat(item.destination);if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error('非一般目錄');
      strictDigest=await store.fingerprint(item.destination,true);
      const shared=(store.db.packDeployments || []).some(d=>d.target===target && d.members.some(m=>m.name===skill.name && m.skillId!==skill.id));
      const managedId=managed?.skillId || store.db.installs.find(r=>r.destination===item.destination && r.digest===managed?.digest)?.skillId;
      if(shared || (managedId && managedId!==skill.id))message='其他收藏版本的套組仍使用此位置，保留檔案';
      else if(strictDigest===(skill.strictDigest || skill.digest) || (managedId===skill.id && strictDigest===managed?.strictDigest)) {
        action='remove';message='備份後解除安裝';
      }
    }catch(error){if(error.code==='ENOENT'){action='missing';message='目標已不存在，清理安裝紀錄';}}
    items.push({...item,project,action,message,strictDigest,managed:managed || null});
  }
  return items;
}
async function uninstall(store,item) {
  const target=await store.target(item.tool,item.scope,item.project);
  if(item.destination!==path.join(target,path.basename(item.destination)))throw new Error('安裝位置已變更');
  const stat=await fs.lstat(item.destination);
  if(!stat.isDirectory() || stat.isSymbolicLink() || await store.fingerprint(item.destination,true)!==item.strictDigest)throw new Error('安裝內容已變更，請重新預覽');
  const recovery=path.join(target,'.skillshub-recovery');
  try {if((await fs.lstat(recovery)).isSymbolicLink())throw new Error('備份目錄不可為符號連結');}catch(e){if(e.code!=='ENOENT')throw e;}
  const dir=path.join(recovery,randomUUID()),backup=path.join(dir,path.basename(item.destination));await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'restore.json'),JSON.stringify({original:item.destination,backup,at:new Date().toISOString()},null,2),{flag:'wx'});
  await fs.rename(item.destination,backup);store.rollbackOperations.push(()=>fs.rename(backup,item.destination));
  if(await store.fingerprint(backup,true)!==item.strictDigest)throw new Error('解除安裝時內容變更，已取消');
  return {...item,backup};
}

async function removalPlan(store,id) {
  const skill=store.skill(id);
  let digest=null;
  try { const stat=await fs.lstat(store.folder(id));if(!stat.isDirectory() || stat.isSymbolicLink())throw new Error('收藏位置不是一般資料夾，請先處理後再移除');digest=await store.fingerprint(store.folder(id),true); }
  catch(error){if(error.code!=='ENOENT')throw error;}
  const info=(await store.list()).skills.find(s=>s.id===id);
  return {skill:structuredClone(skill),digest,packs:structuredClone(store.db.packs.filter(p=>p.members.some(m=>m.skillId===id))),
    installations:await installationPlan(store,skill,info.installations),records:structuredClone(store.db.installs.filter(r=>r.skillId===id)),
    deployments:structuredClone((store.db.packDeployments || []).filter(d=>d.members.some(m=>m.skillId===id))),
    ownership:structuredClone((store.db.managedInstalls || []).filter(r=>r.skillId===id || info.installations.some(i=>i.destination===r.destination)))};
}
export async function previewRemoval(store,id) {
  await prunePreviews(store);const plan=await removalPlan(store,id),token=randomUUID();
  store.previews.set(token,{kind:'collection-removal',plan,expiresAt:Date.now()+600000});return {...plan,token};
}
export async function confirmRemoval(store,token) {
  const entry=store.previews.get(token);
  if(!entry || entry.kind!=='collection-removal')throw new Error('移除預覽已失效，請重新預覽');
  store.previews.delete(token);if(entry.expiresAt<=Date.now())throw new Error('移除預覽已失效，請重新預覽');
  const plan=await removalPlan(store,entry.plan.skill.id);
  if(JSON.stringify(plan)!==JSON.stringify(entry.plan))throw new Error('收藏、套組或安裝狀態已變更，請重新預覽');
  const {skill}=plan,original=store.folder(skill.id),recovery=path.join(store.root,'recovery');
  try {if((await fs.lstat(recovery)).isSymbolicLink())throw new Error('備份目錄不可為符號連結');}catch(e){if(e.code!=='ENOENT')throw e;}
  const dir=path.join(recovery,randomUUID()),backup=path.join(dir,skill.id);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'restore.json'),JSON.stringify({kind:'collection-removal',original,backup:plan.digest?backup:null,...plan,at:new Date().toISOString()},null,2),{flag:'wx'});
  if(plan.digest){await fs.rename(original,backup);store.rollbackOperations.push(()=>fs.rename(backup,original));if(await store.fingerprint(backup,true)!==plan.digest)throw new Error('收藏內容已變更，已取消移除');}
  const uninstalled=[];
  for(const item of plan.installations)if(item.action==='remove')uninstalled.push(await uninstall(store,item));
  store.db.skills=store.db.skills.filter(s=>s.id!==skill.id);
  for(const pack of store.db.packs)if(pack.members.some(m=>m.skillId===skill.id)){
    pack.members=pack.members.filter(m=>m.skillId!==skill.id);pack.revision++;pack.updatedAt=new Date().toISOString();
  }
  // Remove successfully uninstalled associations; preserve conflicts for later explicit resolution.
  for(const item of plan.installations){
    if(item.action!=='keep') {
      store.db.installs=store.db.installs.filter(r=>r.destination!==item.destination);
      store.db.managedInstalls=(store.db.managedInstalls || []).filter(r=>r.destination!==item.destination);
      for(const d of store.db.packDeployments || [])if(d.target===path.dirname(item.destination))d.members=d.members.filter(m=>m.skillId!==skill.id);
      continue;
    }
    const record=store.db.installs.find(r=>r.skillId===skill.id && r.destination===item.destination);
    if(record)record.name=skill.name;
    else store.db.installs.push({id:randomUUID(),skillId:skill.id,name:skill.name,tool:item.tool,scope:item.scope,destination:item.destination,digest:skill.digest,discovered:true});
  }
  return {removed:skill.id,name:skill.name,packs:plan.packs.length,backup:dir,uninstalled,kept:plan.installations.filter(i=>i.action==='keep')};
}
