import fs from 'node:fs/promises';
import path from 'node:path';
export async function installationTargets(store,ids,packId) {
  if(packId){const p=store.db.packs.find(p=>p.id===packId);if(!p)throw new Error('找不到套組');ids=p.members.map(m=>m.skillId);}
  if(!Array.isArray(ids) || ids.length>300)throw new Error('請選擇 Skills');
  const skills=ids.map(id=>store.skill(id)), candidates=new Map();
  const add=(tool,scope,project='')=>candidates.set(JSON.stringify([tool,scope,project]),{tool,scope,project});
  for(const tool of ['codex','claude']){add(tool,'user');for(const p of store.db.projects)add(tool,'project',p.path);}
  for(const r of store.db.installs)if(ids.includes(r.skillId))add(r.tool,r.scope,r.scope==='project'?path.dirname(path.dirname(path.dirname(r.destination))):'');
  for(const d of store.db.packDeployments || [])if(d.packId===packId)add(d.tool,d.scope,d.project);
  const targets=[];
  for(const item of candidates.values()) {
    try {
      const target=await store.target(item.tool,item.scope,item.project),installed=[];
      for(const s of skills)try{await fs.lstat(path.join(target,s.name));installed.push(s.name);}catch(e){if(e.code!=='ENOENT')throw e;}
      if(installed.length || (store.db.packDeployments || []).some(d=>packId && d.packId===packId && d.target===target))targets.push({...item,target,installed});
    }catch(error){targets.push({...item,error:error.message,installed:[]});}
  }
  return {targets};
}
