import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillStore } from '../lib/store.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'skillshub-lifecycle-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'home');await fs.mkdir(home);const source=path.join(root,'source');await fs.mkdir(source);
  const content='---\nname: example\ndescription: Initial description\n---\nFirst\n';await fs.writeFile(path.join(source,'SKILL.md'),content);await fs.writeFile(path.join(source,'old.txt'),'old');
  const store=await new SkillStore(path.join(root,'data'),home).init();await store.mutate(()=>store.importLocal(source));const skill=store.db.skills[0];
  const pack=await store.mutate(()=>store.savePack({name:'Pack',purpose:'',members:[{skillId:skill.id,reason:'Keep reason'}]}));
  const target={tool:'codex',scope:'user',packId:pack.id};const destination=path.join(home,'.agents/skills/example');
  const legacy=async()=>{await fs.mkdir(destination,{recursive:true});await store.copy(store.folder(skill.id),destination);};
  const apply=plan=>store.mutate(()=>store.confirmInstall(plan.token));
  const sourceEdit=async()=>{await fs.writeFile(path.join(source,'SKILL.md'),content.replace('First','Second').replace('Initial','Updated'));await fs.rm(path.join(source,'old.txt'),{force:true});await fs.writeFile(path.join(source,'new.txt'),'new');};
  const sourceUpdate=async()=>{await sourceEdit();const p=await store.previewSourceUpdate(skill.id);return store.mutate(()=>store.confirmSourceUpdate(p.token));};
  return {root,home,source,store,skill,pack,target,destination,legacy,apply,sourceEdit,sourceUpdate};
}
test('explicit adoption leaves bytes unchanged, persists ownership, then enables pack removal',async t=>{
  const f=await fixture(t);await f.legacy();const old=await fs.readFile(path.join(f.destination,'SKILL.md'));
  const p=await f.store.previewAdoption(f.target);assert.equal(p.items[0].eligible,true);
  await f.store.mutate(()=>f.store.confirmAdoption(p.token,[f.skill.id]));assert.deepEqual(await fs.readFile(path.join(f.destination,'SKILL.md')),old);
  const restarted=await new SkillStore(f.store.root,f.home).init();assert.equal(restarted.db.managedInstalls[0].skillId,f.skill.id);
  await f.store.mutate(()=>f.store.savePack({...f.pack,members:[]}));const removal=await f.store.previewInstall([],'codex','user',undefined,f.pack.id);assert.equal(removal.items[0].action,'remove');await f.apply(removal);
  await assert.rejects(fs.stat(f.destination),{code:'ENOENT'});
});
test('adoption refuses unselected, foreign, changed, stale and extra-file candidates',async t=>{
  const f=await fixture(t);await f.legacy();let p=await f.store.previewAdoption(f.target);
  await assert.rejects(f.store.mutate(()=>f.store.confirmAdoption(p.token,[])),/勾選/);
  p=await f.store.previewAdoption(f.target);await assert.rejects(f.store.mutate(()=>f.store.confirmAdoption(p.token,['foreign'])),/勾選/);
  p=await f.store.previewAdoption(f.target);await fs.writeFile(path.join(f.destination,'.DS_Store'),'local');
  await assert.rejects(f.store.mutate(()=>f.store.confirmAdoption(p.token,[f.skill.id])),/變更/);
  p=await f.store.previewAdoption(f.target);assert.equal(p.items[0].eligible,false);
  await fs.rm(path.join(f.destination,'.DS_Store'));await fs.appendFile(path.join(f.destination,'SKILL.md'),'local edits');
  p=await f.store.previewAdoption(f.target);assert.equal(p.items[0].eligible,false);
  assert.equal(f.store.db.managedInstalls,undefined);
});
test('adoption preserves multiple pack and individual dependencies',async t=>{
  const f=await fixture(t);await f.legacy();let p=await f.store.previewAdoption(f.target);await f.store.mutate(()=>f.store.confirmAdoption(p.token,[f.skill.id]));
  const second=await f.store.mutate(()=>f.store.savePack({name:'Shared',purpose:'',members:[{skillId:f.skill.id,reason:''}]}));
  p=await f.store.previewAdoption({...f.target,packId:second.id});await f.store.mutate(()=>f.store.confirmAdoption(p.token,[f.skill.id]));
  let detach=await f.store.previewInstall([],'codex','user',undefined,f.pack.id,true);assert.equal(detach.items[0].action,'keep');await f.apply(detach);
  await f.apply(await f.store.previewInstall([f.skill.id],'codex','user'));
  detach=await f.store.previewInstall([],'codex','user',undefined,second.id,true);assert.equal(detach.items[0].action,'keep');assert.match(detach.items[0].message,/單獨/);
});
test('source update preserves identity and metadata; tool update is a separate backed-up operation',async t=>{
  const f=await fixture(t);await f.store.mutate(()=>f.store.update(f.skill.id,{notes:'mine',tags:['tag'],favorite:true}));
  await f.apply(await f.store.previewInstall([f.skill.id],'codex','user',undefined,f.pack.id));const original=await fs.readFile(path.join(f.destination,'SKILL.md'),'utf8');
  await f.sourceEdit();const sourcePlan=await f.store.previewSourceUpdate(f.skill.id);assert.deepEqual(sourcePlan.changes.map(c=>c.action).sort(),['add','remove','update']);
  const result=await f.store.mutate(()=>f.store.confirmSourceUpdate(sourcePlan.token));assert.equal(await fs.readFile(path.join(f.destination,'SKILL.md'),'utf8'),original);assert.equal(await fs.readFile(path.join(result.backup,'SKILL.md'),'utf8'),original);
  assert.equal(f.skill.notes,'mine');assert.deepEqual(f.skill.tags,['tag']);assert.equal(f.skill.favorite,true);assert.equal(f.store.db.packs[0].members[0].skillId,f.skill.id);
  const plan=await f.store.previewInstall([],'codex','user',undefined,f.pack.id);assert.equal(plan.items[0].action,'update');assert.equal(plan.items[0].changes.length,3);
  const updated=await f.apply(plan);assert.equal(updated[0].status,'updated');assert.equal(await fs.readFile(path.join(updated[0].backup,'SKILL.md'),'utf8'),original);
  await assert.rejects(fs.stat(path.join(f.destination,'old.txt')),{code:'ENOENT'});assert.match(await fs.readFile(path.join(f.destination,'SKILL.md'),'utf8'),/Second/);
  const same=await f.store.previewInstall([],'codex','user',undefined,f.pack.id);assert.equal(same.items[0].action,'same');
});
test('tool update preserves edited and unmanaged installs; refuses edits after preview',async t=>{
  const f=await fixture(t);await f.apply(await f.store.previewInstall([f.skill.id],'codex','user'));await f.sourceUpdate();
  const p=await f.store.previewInstall([f.skill.id],'codex','user');assert.equal(p.items[0].action,'update');
  await fs.writeFile(path.join(f.destination,'.DS_Store'),'custom');await assert.rejects(f.apply(p),/變更/);
  assert.equal((await f.store.previewInstall([f.skill.id],'codex','user')).items[0].action,'conflict');
  await fs.rm(path.join(f.destination,'.DS_Store'));f.store.db.managedInstalls=[];
  assert.equal((await f.store.previewInstall([f.skill.id],'codex','user')).items[0].action,'conflict');
});
test('source previews reject manual library edits, name changes, token reuse and snapshot tampering',async t=>{
  const f=await fixture(t);await f.sourceEdit();let p=await f.store.previewSourceUpdate(f.skill.id);
  await fs.appendFile(path.join(f.store.folder(f.skill.id),'SKILL.md'),'manual');await assert.rejects(f.store.mutate(()=>f.store.confirmSourceUpdate(p.token)),/變更/);
  await assert.rejects(f.store.previewSourceUpdate(f.skill.id),/手動修改/);
  await fs.writeFile(path.join(f.store.folder(f.skill.id),'SKILL.md'),'---\nname: example\ndescription: Initial description\n---\nFirst\n');
  p=await f.store.previewSourceUpdate(f.skill.id);const staging=f.store.previews.get(p.token);await fs.writeFile(path.join(staging.snapshot,'new.txt'),'tampered');
  await assert.rejects(f.store.mutate(()=>f.store.confirmSourceUpdate(p.token)),/變更/);await assert.rejects(fs.stat(staging.staging),{code:'ENOENT'});
  await fs.writeFile(path.join(f.source,'SKILL.md'),'---\nname: renamed\ndescription: Test\n---\n');await assert.rejects(f.store.previewSourceUpdate(f.skill.id),/名稱改變/);
});
test('catalog write failure restores library and tool contents after updates',async t=>{
  const f=await fixture(t);await f.apply(await f.store.previewInstall([f.skill.id],'codex','user'));await f.sourceEdit();let p=await f.store.previewSourceUpdate(f.skill.id);
  const originalWrite=fs.writeFile,fail=()=>{fs.writeFile=async (file,...args)=>{if(String(file).startsWith(path.join(f.store.root,'catalog-')))throw new Error('disk full');return originalWrite(file,...args);};};
  t.after(()=>{fs.writeFile=originalWrite;});fail();await assert.rejects(f.store.mutate(()=>f.store.confirmSourceUpdate(p.token)),/disk full/);fs.writeFile=originalWrite;
  assert.match(await fs.readFile(path.join(f.store.folder(f.skill.id),'SKILL.md'),'utf8'),/First/);
  p=await f.store.previewSourceUpdate(f.skill.id);await f.store.mutate(()=>f.store.confirmSourceUpdate(p.token));
  const install=await f.store.previewInstall([f.skill.id],'codex','user');fail();await assert.rejects(f.apply(install),/disk full/);fs.writeFile=originalWrite;
  assert.match(await fs.readFile(path.join(f.destination,'SKILL.md'),'utf8'),/First/);assert.equal((await f.store.previewInstall([f.skill.id],'codex','user')).items[0].action,'update');
});
test('unchanged source, expiration and preview kind isolation do not mutate data',async t=>{
  const f=await fixture(t);const p=await f.store.previewSourceUpdate(f.skill.id);assert.equal(p.canApply,false);
  await assert.rejects(f.apply(p),/失效/);assert.ok(f.store.previews.has(p.token));
  const entry=f.store.previews.get(p.token);entry.expiresAt=0;await assert.rejects(f.store.mutate(()=>f.store.confirmSourceUpdate(p.token)),/失效/);await assert.rejects(fs.stat(entry.staging),{code:'ENOENT'});
  await assert.rejects(f.store.mutate(()=>f.store.confirmSourceUpdate(p.token)),/失效/);
});

test('updating an adopted skill directly retains pack ownership without creating an individual pin',async t=>{
  const f=await fixture(t);await f.legacy();const p=await f.store.previewAdoption(f.target);await f.store.mutate(()=>f.store.confirmAdoption(p.token,[f.skill.id]));await f.sourceUpdate();
  await f.apply(await f.store.previewInstall([f.skill.id],'codex','user'));
  assert.deepEqual(f.store.db.managedInstalls[0].owners,[`pack:${f.pack.id}`]);
  assert.equal((await f.store.previewInstall([],'codex','user',undefined,f.pack.id,true)).items[0].action,'remove');
});

test('GitHub source snapshots retain repository, subdirectory and revision through the shared import adapter',async t=>{
  const f=await fixture(t);await f.sourceEdit();
  const upstream={type:'github',location:'https://github.com/example/skills',subdirectory:'.agents/skills/example',revision:'old'};f.skill.source=upstream;
  class FixtureStore extends SkillStore {
    async importGitHub(location,subdirectory) {
      assert.equal(location,upstream.location);assert.equal(subdirectory,upstream.subdirectory);
      const result=await this.importLocal(f.source);this.db.skills[0].source={...upstream,revision:'new'};return result;
    }
  }
  f.store.constructor=FixtureStore;
  const p=await f.store.previewSourceUpdate(f.skill.id);assert.equal(p.oldRevision,'old');assert.equal(p.source.revision,'new');
  await f.store.mutate(()=>f.store.confirmSourceUpdate(p.token));assert.equal(f.skill.source.revision,'new');assert.equal(f.skill.source.subdirectory,upstream.subdirectory);
});

test('adoption and content updates isolate both tools and scopes',async t=>{
  const f=await fixture(t),project=path.join(f.root,'project');await fs.mkdir(project);
  for(const tool of ['codex','claude'])for(const scope of ['user','project']){
    const root=await f.store.target(tool,scope,project),destination=path.join(root,f.skill.name);await fs.mkdir(destination,{recursive:true});await f.store.copy(f.store.folder(f.skill.id),destination);
    const p=await f.store.previewAdoption({tool,scope,project,packId:f.pack.id});await f.store.mutate(()=>f.store.confirmAdoption(p.token,[f.skill.id]));
  }
  await f.sourceUpdate();for(const tool of ['codex','claude'])for(const scope of ['user','project']){
    const p=await f.store.previewInstall([] ,tool,scope,project,f.pack.id);assert.equal(p.items[0].action,'update');await f.apply(p);
  }
  assert.equal(f.store.db.packDeployments.length,4);assert.equal(f.store.db.managedInstalls.length,4);
});

test('a shared destination requested as another collected version remains a conflict',async t=>{
  const f=await fixture(t);await f.apply(await f.store.previewInstall([f.skill.id],'codex','user',undefined,f.pack.id));
  const extra=path.join(f.root,'another');await fs.mkdir(extra);await fs.writeFile(path.join(extra,'SKILL.md'),'---\nname: example\ndescription: Other version\n---\n');await f.store.mutate(()=>f.store.importLocal(extra));
  const other=f.store.db.skills[1],p=await f.store.mutate(()=>f.store.savePack({name:'Other',purpose:'',members:[{skillId:other.id,reason:''}]}));await f.apply(await f.store.previewInstall([],'codex','user',undefined,p.id));
  await f.sourceUpdate();assert.equal((await f.store.previewInstall([],'codex','user',undefined,f.pack.id)).items[0].action,'conflict');
});

test('collection removal archives metadata and uninstalls alongside pack reference cleanup',async t=>{
  const f=await fixture(t);await f.store.mutate(()=>f.store.update(f.skill.id,{notes:'personal note'}));
  await f.apply(await f.store.previewInstall([],'codex','user',undefined,f.pack.id));
  const p=await f.store.previewRemoval(f.skill.id);assert.equal(p.packs.length,1);assert.equal(p.installations.length,1);
  const result=await f.store.mutate(()=>f.store.confirmRemoval(p.token));
  assert.equal(f.store.db.skills.length,0);assert.equal(f.store.db.packs[0].members.length,0);assert.equal(f.store.db.packs[0].revision,p.packs[0].revision+1);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.backup,'restore.json'),'utf8')).skill.notes,'personal note');
  await assert.rejects(fs.stat(f.destination),{code:'ENOENT'});await fs.stat(path.join(result.backup,f.skill.id,'SKILL.md'));
  await fs.stat(path.join(result.uninstalled[0].backup,'SKILL.md'));
  const sync=await f.store.previewInstall([],'codex','user',undefined,f.pack.id);assert.equal(sync.items.length,0);
  assert.equal((await f.store.list()).detachedInstalls.length,0);await assert.rejects(f.store.mutate(()=>f.store.confirmRemoval(p.token)),/失效/);
});
test('removing a collection preserves separate source and removes individual installs across restart',async t=>{
  const f=await fixture(t);await f.apply(await f.store.previewInstall([f.skill.id],'codex','user'));
  const plan=await f.store.previewRemoval(f.skill.id);await f.store.mutate(()=>f.store.confirmRemoval(plan.token));
  await fs.stat(path.join(f.source,'SKILL.md'));await assert.rejects(fs.stat(f.destination),{code:'ENOENT'});
  const restart=await new SkillStore(f.store.root,f.home).init();assert.equal(restart.db.skills.length,0);assert.equal((await restart.list()).detachedInstalls.length,0);
});
test('collection removal rejects stale previews and restores files on catalog write failure',async t=>{
  const f=await fixture(t);let plan=await f.store.previewRemoval(f.skill.id);
  await f.store.mutate(()=>f.store.update(f.skill.id,{notes:'changed'}));await assert.rejects(f.store.mutate(()=>f.store.confirmRemoval(plan.token)),/變更/);
  plan=await f.store.previewRemoval(f.skill.id);await f.store.mutate(()=>f.store.savePack({...f.store.db.packs[0],purpose:'changed'}));await assert.rejects(f.store.mutate(()=>f.store.confirmRemoval(plan.token)),/變更/);
  plan=await f.store.previewRemoval(f.skill.id);const write=fs.writeFile;t.after(()=>{fs.writeFile=write;});fs.writeFile=async (file,...args)=>{if(String(file).startsWith(path.join(f.store.root,'catalog-')))throw new Error('disk full');return write(file,...args);};
  await assert.rejects(f.store.mutate(()=>f.store.confirmRemoval(plan.token)),/disk full/);fs.writeFile=write;
  assert.equal(f.store.db.skills.length,1);assert.equal(f.store.db.packs[0].members.length,1);await fs.stat(path.join(f.store.folder(f.skill.id),'SKILL.md'));
});

test('collection uninstall finds untracked installs in saved projects for both tools and preserves conflicts',async t=>{
  const f=await fixture(t),project=path.join(f.root,'saved');await fs.mkdir(project);await f.store.mutate(()=>f.store.addProject(project));
  const targets=[];for(const tool of ['codex','claude'])for(const scope of ['user','project']){
    const target=path.join(await f.store.target(tool,scope,project),f.skill.name);await fs.mkdir(target,{recursive:true});await f.store.copy(f.store.folder(f.skill.id),target);targets.push(target);
  }
  await fs.writeFile(path.join(targets[3],'custom.txt'),'my edit');
  const p=await f.store.previewRemoval(f.skill.id);assert.equal(p.installations.filter(i=>i.action==='remove').length,3);assert.equal(p.installations.filter(i=>i.action==='keep').length,1);
  const result=await f.store.mutate(()=>f.store.confirmRemoval(p.token));assert.equal(result.uninstalled.length,3);assert.equal(result.kept.length,1);
  for(const destination of targets.slice(0,3))await assert.rejects(fs.stat(destination),{code:'ENOENT'});
  assert.equal(await fs.readFile(path.join(targets[3],'custom.txt'),'utf8'),'my edit');
});
test('combined uninstall rejects stale file edits and rolls back installations when catalog cannot save',async t=>{
  const f=await fixture(t);await f.apply(await f.store.previewInstall([f.skill.id],'codex','user'));let p=await f.store.previewRemoval(f.skill.id);
  await fs.writeFile(path.join(f.destination,'extra.txt'),'edited');await assert.rejects(f.store.mutate(()=>f.store.confirmRemoval(p.token)),/變更/);await fs.rm(path.join(f.destination,'extra.txt'));
  p=await f.store.previewRemoval(f.skill.id);const write=fs.writeFile;t.after(()=>{fs.writeFile=write;});fs.writeFile=async(file,...args)=>{if(String(file).startsWith(path.join(f.store.root,'catalog-')))throw new Error('disk full');return write(file,...args);};
  await assert.rejects(f.store.mutate(()=>f.store.confirmRemoval(p.token)),/disk full/);fs.writeFile=write;
  await fs.stat(path.join(f.destination,'SKILL.md'));await fs.stat(path.join(f.store.folder(f.skill.id),'SKILL.md'));assert.equal(f.store.db.skills.length,1);assert.equal(f.store.db.installs.length,1);
});

test('project-only legacy installs are discovered and linked through the ordinary sync preview',async t=>{
  const f=await fixture(t),project=path.join(f.root,'only-project');await fs.mkdir(project);await f.store.mutate(()=>f.store.addProject(project));
  const dest=path.join(await f.store.target('claude','project',project),f.skill.name);await fs.mkdir(dest,{recursive:true});await f.store.copy(f.store.folder(f.skill.id),dest);
  const found=await f.store.installationTargets([f.skill.id]);assert.equal(found.targets.length,1);assert.equal(found.targets[0].scope,'project');assert.equal(found.targets[0].tool,'claude');
  assert.equal((await f.store.list()).skills[0].installations[0].scope,'project');
  const p=await f.store.previewInstall([],'claude','project',project,f.pack.id,false,true);assert.equal(p.items[0].action,'link');assert.equal((await f.apply(p))[0].status,'linked');
  const remove=await f.store.previewInstall([],'claude','project',project,f.pack.id,true,true);assert.equal(remove.items[0].action,'remove');
});
test('a legacy project install can update after source refresh without a separate management step',async t=>{
  const f=await fixture(t),project=path.join(f.root,'project');await fs.mkdir(project);await f.store.mutate(()=>f.store.addProject(project));
  const dest=path.join(await f.store.target('codex','project',project),f.skill.name);await fs.mkdir(dest,{recursive:true});await f.store.copy(f.store.folder(f.skill.id),dest);
  await f.sourceUpdate();const p=await f.store.previewInstall([f.skill.id],'codex','project',project,null,false,true);assert.equal(p.items[0].action,'update');await f.apply(p);assert.match(await fs.readFile(path.join(dest,'SKILL.md'),'utf8'),/Second/);
  assert.equal(f.store.db.managedInstalls.length,1);assert.ok((await f.store.list()).skills[0].previousDigests.length);
});
test('integrated sync keeps edited legacy files and detects post-preview edits',async t=>{
  const f=await fixture(t);await f.legacy();const p=await f.store.previewInstall([f.skill.id],'codex','user',undefined,null,false,true);assert.equal(p.items[0].action,'link');
  await fs.writeFile(path.join(f.destination,'extra.txt'),'local');await assert.rejects(f.apply(p),/變更/);
  await f.sourceUpdate();assert.equal((await f.store.previewInstall([f.skill.id],'codex','user',undefined,null,false,true)).items[0].action,'conflict');
});
