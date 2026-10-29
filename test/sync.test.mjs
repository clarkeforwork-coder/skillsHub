import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SkillStore } from '../lib/store.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skillshub-sync-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const home = path.join(root,'home'); await fs.mkdir(home);
  const store = await new SkillStore(path.join(root,'data'),home).init();
  for (const name of ['alpha','beta']) {
    const src=path.join(root,name);await fs.mkdir(src);
    await fs.writeFile(path.join(src,'SKILL.md'),`---\nname: ${name}\ndescription: Test\n---\n${name}\n`);
    await store.mutate(()=>store.importLocal(src));
  }
  const [a,b]=store.db.skills;
  const makePack = async (name,ids=[a.id]) => structuredClone(await store.mutate(()=>store.savePack({name,purpose:'',members:ids.map(skillId=>({skillId,reason:''}))})));
  const preview = (p,detach=false,tool='codex',scope='user',project) => store.previewInstall([],tool,scope,project,p.id,detach);
  const apply = plan => store.mutate(()=>store.confirmInstall(plan.token));
  const edit = async (p,ids) => store.mutate(()=>store.savePack({...store.db.packs.find(x=>x.id===p.id),members:ids.map(skillId=>({skillId,reason:''}))}));
  return {store,root,home,a,b,makePack,preview,apply,edit};
}

test('sync previews removals, retains backup, supports empty packs, persists target provenance',async t=>{
  const f=await fixture(t),p=await f.makePack('first');
  const initial=await f.preview(p);assert.equal(initial.items[0].action,'add');await f.apply(initial);
  await f.edit(p,[f.b.id]);const plan=await f.preview(p);
  assert.deepEqual(plan.items.map(i=>i.action),['add','remove']);
  const old=plan.items.find(i=>i.action==='remove').destination;
  assert.ok(await fs.stat(old));const result=await f.apply(plan);
  await assert.rejects(fs.stat(old),{code:'ENOENT'});
  assert.ok(await fs.stat(path.join(result.find(i=>i.status==='removed').backup,'SKILL.md')));
  const restarted=await new SkillStore(f.store.root,f.home).init();assert.equal(restarted.db.packDeployments[0].members[0].skillId,f.b.id);
  await f.edit(p,[]);const empty=await f.preview(p);assert.equal(empty.items[0].action,'remove');await f.apply(empty);
  assert.equal(f.store.db.packDeployments[0].members.length,0);
});

test('shared and individual references protect files; last pack can remove its exclusive files',async t=>{
  const f=await fixture(t),p=await f.makePack('one'),q=await f.makePack('two');
  await f.apply(await f.preview(p));await f.apply(await f.preview(q));
  let plan=await f.preview(p,true);assert.equal(plan.items[0].action,'keep');assert.match(plan.items[0].message,/其他套組/);await f.apply(plan);
  plan=await f.preview(q,true);assert.equal(plan.items[0].action,'remove');
  const single=await f.store.previewInstall([f.a.id],'codex','user');await f.apply(single);
  await assert.rejects(f.apply(plan),/變更/);
  plan=await f.preview(q,true);assert.equal(plan.items[0].action,'keep');assert.match(plan.items[0].message,/單獨安裝/);await f.apply(plan);
  assert.ok(await fs.stat(plan.items[0].destination));assert.equal(f.store.db.packDeployments.length,0);
});

test('legacy and preexisting files are never adopted for deletion',async t=>{
  const f=await fixture(t),p=await f.makePack('legacy');
  await f.store.mutate(()=>f.store.install([f.a.id],'codex','user'));
  await f.store.mutate(()=>{delete f.store.db.managedInstalls;});
  await f.apply(await f.preview(p));await f.edit(p,[]);
  const plan=await f.preview(p);assert.equal(plan.items[0].action,'keep');assert.match(plan.items[0].message,/舊版/);await f.apply(plan);
  assert.ok(await fs.stat(plan.items[0].destination));
});

test('local edits including ignored files and symlinks are preserved',async t=>{
  for (const kind of ['edit','ignored','link']) {
    const f=await fixture(t),p=await f.makePack(kind);const initial=await f.preview(p);await f.apply(initial);
    const dest=initial.items[0].destination;
    if(kind==='edit')await fs.appendFile(path.join(dest,'SKILL.md'),'local changes');
    if(kind==='ignored') {await fs.mkdir(path.join(dest,'node_modules'));await fs.writeFile(path.join(dest,'node_modules','extra'),'user data');}
    if(kind==='link')await fs.symlink(f.root,path.join(dest,'link'));
    const plan=await f.preview(p,true);assert.equal(plan.items[0].action,'keep');await f.apply(plan);assert.ok(await fs.stat(dest));
  }
});

test('sync refuses stale pack revisions and post-preview target changes; tokens cannot replay',async t=>{
  const f=await fixture(t),p=await f.makePack('stale');const initial=await f.preview(p);
  await f.edit(p,[f.a.id,f.b.id]);await assert.rejects(f.apply(initial),/變更/);
  await f.apply(await f.preview(p));const removal=await f.preview(p,true);
  await fs.appendFile(path.join(removal.items[0].destination,'SKILL.md'),'changed');
  await assert.rejects(f.apply(removal),/變更/);await assert.rejects(f.apply(removal),/失效/);
});

test('sync isolates all tool and scope targets and prevents deleting tracked pack',async t=>{
  const f=await fixture(t),p=await f.makePack('scoped');const project=path.join(f.root,'project');await fs.mkdir(project);
  for(const tool of ['codex','claude'])for(const scope of ['user','project'])await f.apply(await f.preview(p,false,tool,scope,project));
  assert.equal(f.store.db.packDeployments.length,4);
  await assert.rejects(f.store.mutate(()=>f.store.deletePack(p.id,p.revision)),/解除/);
  const plan=await f.preview(p,true,'claude','project',project);await f.apply(plan);
  assert.equal(f.store.db.packDeployments.length,3);
  for(const d of f.store.db.packDeployments)assert.ok(await fs.stat(path.join(d.target,'alpha')));
});

test('catalog write failure rolls back additions and removal while retaining original metadata',async t=>{
  const f=await fixture(t),p=await f.makePack('rollback');await f.apply(await f.preview(p));await f.edit(p,[f.b.id]);
  const plan=await f.preview(p),before=structuredClone(f.store.db);
  const original=fs.writeFile;fs.writeFile=async (file,...args)=>{if(String(file).includes('catalog-'))throw new Error('disk failure');return original(file,...args);};
  try {await assert.rejects(f.apply(plan),/disk failure/);}finally{fs.writeFile=original;}
  assert.deepEqual(f.store.db,before);assert.ok(await fs.stat(plan.items.find(i=>i.action==='remove').destination));
  await assert.rejects(fs.stat(plan.items.find(i=>i.action==='add').destination),{code:'ENOENT'});
});

test('new version with same name remains conflict and is not silently overwritten',async t=>{
  const f=await fixture(t),p=await f.makePack('versions');await f.apply(await f.preview(p));
  await fs.appendFile(path.join(f.root,'alpha','SKILL.md'),'new version');await f.store.mutate(()=>f.store.importLocal(path.join(f.root,'alpha')));
  await f.edit(p,[f.store.db.skills.at(-1).id]);const plan=await f.preview(p);
  assert.equal(plan.items[0].action,'conflict');assert.equal(plan.items.length,1);await f.apply(plan);
  assert.equal(await f.store.fingerprint(plan.items[0].destination),f.a.digest);
});

test('recreating a missing directory preserves references of previously deployed packs',async t=>{
  const f=await fixture(t),p=await f.makePack('first'),q=await f.makePack('second');
  const initial=await f.preview(p);await f.apply(initial);
  await fs.rm(initial.items[0].destination,{recursive:true});
  await f.apply(await f.preview(q));
  const detach=await f.preview(q,true);assert.equal(detach.items[0].action,'keep');assert.match(detach.items[0].message,/其他套組/);
});
