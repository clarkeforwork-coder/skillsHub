// SkillsHub: persistent library, packs and tool configuration.
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = { library:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', packs:'M3 7l9-4 9 4-9 4z M3 12l9 4 9-4 M3 17l9 4 9-4', tools:'M4 4h16v12H4z M8 21h8 M12 16v5', search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', plus:'M12 5v14 M5 12h14', arrow:'M5 12h14 M13 6l6 6-6 6', star:'M12 3l3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z', clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', close:'M6 6l12 12 M6 18L18 6', file:'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6', folder:'M3 6h7l2 3h9v12H3z', check:'M5 12l4 4L19 6', settings:'M4 7h16 M4 17h16 M8 4v6 M16 14v6' };
const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
const labels = { library: '私人收藏', packs: '任務套組', tools: '工具配置' };
const initialView = new URL(location.href).searchParams.get('screen');
const state = { configQuery: '', configStatus: '', view: labels[initialView] ? initialView : 'library', skills: [], packs: [], projects: [], focus: null, pack: null, query: '', filter: 'all', tag: '', source: '', selected: new Set(), detailTab: 'overview', tool: 'codex', scope: 'user', project: '', projectConfig: null, projectError: '', projectLoading: false, busy: false, loaded: false, details: new Map(), detailError: '', targets: {} };
const skill = id => state.skills.find(s => s.id === id);
const pack = () => state.packs.find(p => p.id === state.pack);
const toolNames = { codex: 'Codex', claude: 'Claude Code' };
const sourceName = s => s.source.type === 'github' ? s.source.location.replace(/^https:\/\/github.com\//, '').replace(/\.git\/?$/, '') : '本機收藏';
const shortDate = value => new Date(value).toLocaleDateString('zh-TW');
const enabled = (s, tool) => s.installations.some(i => i.tool === tool && i.scope === 'user' && i.status === 'current');
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
async function api(route, body) {
  const response = await fetch('/api/' + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SkillsHub-Request': '1' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作失敗');
  return data;
}
async function load() {
  const data = await api('skills');
  state.detachedInstalls = data.detachedInstalls || [];
  state.deployments = data.deployments || []; state.skills = data.skills; state.packs = data.packs; state.projects = data.projects || []; state.targets = data.targets; state.suggestedImport = data.suggestedImport;
  state.selected = new Set([...state.selected].filter(id=>skill(id)));
  if (!skill(state.focus)) state.focus = state.skills[0]?.id || null;
  if (!pack()) state.pack = state.packs[0]?.id || null;
  if (!state.projectsMigrated) {
    state.projectsMigrated = true;
    if (state.project && !state.projects.some(p => p.path === state.project)) {
      try { const p = await api('projects/add', { path: state.project }); state.projects.push(p); } catch {}
    }
  }
  if (!state.project) state.project = state.projects[0]?.path || '';
  state.loaded = true; render();
  await loadDetail();
}
async function loadDetail() {
  const id = state.focus;
  if (!id || state.details.has(id)) return;
  state.detailError = '';
  try { state.details.set(id, await api('skills/' + id)); }
  catch (error) { if (state.focus === id) state.detailError = error.message; }
  if (state.focus === id && state.view === 'library') renderDetail();
}
function go(view) { state.view = view; const url = new URL(location.href); url.searchParams.set('screen', view); history.replaceState({}, '', url); render(); }
function currentSkills() {
  const q = state.query.trim().toLowerCase();
  return state.skills.filter(s => (state.filter !== 'favorites' || s.favorite) && (!state.tag || s.tags.includes(state.tag)) && (!state.source || sourceName(s) === state.source) && (!q || [s.name, s.description, s.summary, s.useCase, s.notes, ...s.tags].join(' ').toLowerCase().includes(q))).sort((a, b) => state.filter === 'recent' ? b.createdAt.localeCompare(a.createdAt) : a.name.localeCompare(b.name));
}
function sidebar() {
  const tags = [...new Set(state.skills.flatMap(s => s.tags))].sort();
  $('sidebar').innerHTML = `<div class="brand"><span class="mark">s</span><span class="wordmark">skillshub.</span></div><div class="workspace-switch"><span class="avatar">我</span><div>我的工作空間<small>PERSONAL WORKSPACE</small></div></div><p class="section-label">工作區</p>${Object.entries(labels).map(([id, label]) => `<button class="nav ${state.view === id ? 'active' : ''}" data-screen="${id}" title="${label}">${icon(id)}<span class="nav-text">${label}</span><span class="count">${id === 'library' ? state.skills.length : id === 'packs' ? state.packs.length : '2'}</span></button>`).join('')}<div class="sidebar-divider"></div><div class="sidebar-extra"><p class="section-label">快速存取</p><button class="nav" data-filter="favorites">${icon('star')}常用收藏<span class="count">${state.skills.filter(s => s.favorite).length}</span></button><button class="nav" data-filter="recent">${icon('clock')}最近收錄</button><div class="sidebar-divider"></div><p class="section-label">我的標籤</p>${tags.map(t => `<button class="nav" data-tag="${esc(t)}"><span class="label-dot"></span>${esc(t)}</button>`).join('') || '<p class="sidebar-hint">在 Skill 詳情加入標籤</p>'}</div><div class="sidebar-bottom"><b><span class="live-dot"></span>本機資料庫</b>收藏與套組儲存在本機<br>安裝前先預覽，不覆蓋既有內容</div>`;
}
function render() {
  const listScroll = document.querySelector('.library-main')?.scrollTop || 0;
  let focusChanged = false;
  if (state.loaded && state.view === 'library') {
    const rows = currentSkills();
    if (!rows.some(s => s.id === state.focus)) {
      state.focus = rows[0]?.id || null; state.detailError = ''; state.detailTab = 'overview'; focusChanged = true;
    }
  }
  sidebar();
  $('topbar').innerHTML = `<div class="crumb">我的工作空間<span>/</span><b>${labels[state.view]}</b></div><div class="top-actions"><span class="prototype-badge">${'本機儲存'}</span><span class="avatar">我</span></div>`;
  $('workspace').innerHTML = !state.loaded ? '<div class="empty-row">正在讀取收藏…</div>' : state.view === 'library' ? library() : state.view === 'packs' ? packsPage() : toolsPage();
  bindInputs();
  if (document.querySelector('.library-main')) document.querySelector('.library-main').scrollTop = listScroll;
  if (focusChanged && state.focus) void loadDetail();
}
function library() {
  const rows = currentSkills(), tags = [...new Set(state.skills.flatMap(s => s.tags))].sort(), sources = [...new Set(state.skills.map(sourceName))];
  return `<div class="library-view"><div class="heading"><div><h1>${esc(state.tag || (state.filter === 'favorites' ? '常用收藏' : state.filter === 'recent' ? '最近收錄' : '私人收藏'))}</h1><p>收藏好的方法，在需要的時候找到它。</p></div><button class="primary" data-action="import">${icon('plus')}收錄 Skill</button></div><div class="toolbar"><label class="search">${icon('search')}<input id="search" aria-label="搜尋收藏" placeholder="搜尋名稱、用途、標籤或筆記…" value="${esc(state.query)}"><kbd>/</kbd></label><div class="filters"><select id="tag-filter" aria-label="標籤"><option value="">所有標籤</option>${tags.map(t => `<option ${state.tag === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select><select id="source-filter" aria-label="來源"><option value="">所有來源</option>${sources.map(s => `<option ${state.source === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select><button class="icon-button" data-action="reset-filters" title="清除篩選" aria-label="清除篩選">${icon('close')}</button></div></div><div class="library-layout"><div class="library-main"><div class="list-caption"><span>${rows.length} 個 Skill${state.selected.size ? ` · 已選 ${state.selected.size} 個` : ''}</span><span>${state.filter === 'recent' ? '最近收錄優先' : '點列查看 · 勾選批次操作'}</span></div><table class="skill-list"><thead><tr><th><input type="checkbox" id="select-all" aria-label="選取所有顯示項目" ${rows.length && rows.every(s => state.selected.has(s.id)) ? 'checked' : ''}></th><th>SKILL / 用途</th><th class="tag-column">標籤</th><th title="包含全域、已加入專案及已記錄的安裝">安裝位置</th></tr></thead><tbody>${rows.map(s => `<tr data-skill-row="${s.id}" class="${state.focus === s.id ? 'selected' : ''}"><td><input type="checkbox" data-select="${s.id}" aria-label="選取 ${esc(s.name)}" ${state.selected.has(s.id) ? 'checked' : ''}></td><td><button class="skill-name" data-focus="${s.id}" aria-current="${state.focus === s.id ? 'true' : 'false'}">${esc(s.name)} ${s.favorite ? '<span class="star">⋆</span>' : ''}</button><div class="skill-origin">${esc(sourceName(s))}</div><div class="skill-sub truncate" title="${esc(s.summary || s.description)}">${esc(s.summary || s.description)}</div></td><td class="tag-column">${s.tags.slice(0, 2).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</td><td><div class="tool-chips">${[...new Set(s.installations.filter(i=>i.status!=='missing').map(i=>i.tool+':'+i.scope))].map(key=>{const [tool,scope]=key.split(':');return `<span class="tool-chip">${tool==='codex'?'Codex':'Claude'} · ${scope==='user'?'全域':'專案'}</span>`;}).join('') || '<span class="muted">尚未安裝</span>'}</div></td></tr>`).join('')}</tbody></table>${!rows.length ? `<div class="empty-row">${state.skills.length ? '沒有符合的收藏，試試其他條件。' : '還沒有收藏。從本機資料夾或 GitHub 收錄第一個 Skill。'}</div>` : ''}</div><aside class="detail" id="detail-panel">${detail()}</aside></div>${state.selected.size ? `<div class="selection-bar"><span>已選取 ${state.selected.size} 個 Skill</span><button data-action="clear-selected">清除</button><button data-action="add-to-pack">加入套組</button><button class="primary" data-action="install-selected">安裝到工具</button></div>` : ''}</div>`;
}
function detail() {
  const s = skill(state.focus); if (!s) return '<div class="detail-empty"><span class="skill-symbol">'+icon('file')+'</span><h2>選擇一個 Skill</h2><p>點選左側清單，查看用途、文件與來源。</p></div>';
  const ownPacks = state.packs.filter(p => p.members.some(m => m.skillId === s.id)), d = state.details.get(s.id);
  let content;
  if (state.detailTab === 'overview') content = `<section class="overview-section"><h3>什麼時候用</h3><p>${esc(s.useCase || s.summary || s.description)}</p></section>
    ${s.tags.length ? `<section class="overview-section"><h3>我的標籤</h3><div class="inline-tags">${s.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div></section>` : ''}
    <section class="overview-section"><h3>我的筆記</h3>${s.notes ? `<div class="note">${esc(s.notes)}</div>` : '<p class="empty-metadata">還沒有筆記，記下適合自己的使用方式。</p>'}</section>
    ${ownPacks.length ? `<section class="overview-section"><h3>所屬任務套組</h3><div class="inline-tags">${ownPacks.map(p => `<button class="kit-chip" data-pack="${p.id}">${icon('packs')} ${esc(p.name)}</button>`).join('')}</div></section>` : ''}
    <section class="overview-section"><h3>已偵測的配置</h3>${s.installations.length ? `<ul class="installation-summary">${s.installations.map(i => `<li><b>${toolNames[i.tool]} · ${i.scope === 'user' ? '全域' : '專案'}</b><span>${esc({ current: '內容一致', different: '內容不同', missing: '目錄不存在' }[i.status] || i.status)}</span></li>`).join('')}</ul>` : '<p class="empty-metadata">尚未偵測到安裝</p>'}<p class="detail-hint">完整專案配置可至「工具配置」查看。</p></section>
    <button class="secondary edit-detail" data-action="edit-metadata">編輯用途、標籤與筆記</button><button class="secondary edit-detail" data-action="check-source">檢查來源更新</button>`;
  else if (state.detailTab === 'source') content = `<h3>收藏來源</h3><dl class="source-details"><dt>來源</dt><dd>${esc(sourceName(s))}</dd><dt>來源位置</dt><dd>${esc(s.source.location)}</dd>${s.source.subdirectory ? '<dt>儲存庫內資料夾</dt><dd>' + esc(s.source.subdirectory) + '</dd>' : ''}<dt>收錄日期</dt><dd>${shortDate(s.createdAt)}</dd>${s.source.revision ? '<dt>Commit</dt><dd><code>' + esc(s.source.revision) + '</code></dd>' : ''}<dt>收藏內容指紋</dt><dd><code>${esc(s.digest.slice(0,12))}</code></dd></dl><button class="secondary" data-action="check-source">檢查來源更新</button>`;
  else if (!d) content = state.detailError ? `<p role="alert">${esc(state.detailError)}</p><button class="secondary" data-action="retry-detail">重新讀取</button>` : '<p role="status">正在讀取文件…</p>';
  else content = `<details class="bundle-files"><summary>附帶檔案 · ${d.files.length} 個</summary><ul class="file-tree">${d.files.map(f => `<li>${esc(f)}</li>`).join('')}</ul></details><h3>SKILL.md 原始文件</h3><pre class="skill-document">${esc(d.content)}</pre>`;
  return `<div class="detail-header"><div class="detail-top"><span class="skill-symbol">${icon('file')}</span><div class="detail-tools"><button class="icon-button ${s.favorite ? 'star' : ''}" data-favorite="${s.id}" aria-label="${s.favorite ? '取消' : '加入'}常用收藏">${icon('star')}</button><details class="pack-more"><summary aria-label="收藏更多操作">⋯</summary><div class="pack-more-options"><button class="remove-member" data-action="remove-collection">從私人收藏移除</button></div></details></div></div><h2>${esc(s.name)}</h2><div class="detail-source">${esc(sourceName(s))}</div></div>
  <div class="detail-tabs" role="tablist" aria-label="Skill 詳情">${[['overview','概覽'],['document','文件'],['source','來源']].map(([id,label]) => `<button id="detail-tab-${id}" class="tab" role="tab" aria-selected="${state.detailTab === id}" aria-controls="detail-content" tabindex="${state.detailTab === id ? 0 : -1}" data-tab="${id}">${label}</button>`).join('')}</div>
  <div class="detail-scroll" id="detail-content" role="tabpanel" aria-labelledby="detail-tab-${state.detailTab}" tabindex="0">${content}</div><div class="detail-footer"><button class="secondary" data-action="add-focused">加入套組</button><button class="primary" data-action="preview-focused">安裝／同步</button></div>`;
}

function renderDetail() { if ($('detail-panel')) $('detail-panel').innerHTML = detail(); }
function memberDescription(text) {
  if (text.length <= 140) return `<p>${esc(text)}</p>`;
  return `<details class="member-description"><summary><span class="member-excerpt">${esc(text.slice(0, 140))}…</span><span class="expand-label">展開完整說明</span><span class="collapse-label">收合說明</span></summary><p>${esc(text)}</p></details>`;
}
const reasonDrafts = new Map();
const reasonKey = (packId, skillId) => packId + ':' + skillId;
function memberRow(p, m, i) {
  const s = skill(m.skillId), name = s?.name || '已移除的 Skill', draft = reasonDrafts.get(reasonKey(p.id,m.skillId));
  return `<article class="pack-member compact-member" data-member-id="${m.skillId}"><span class="member-index">${String(i+1).padStart(2,'0')}</span><div class="member-main"><h4>${esc(name)}</h4>${memberDescription(s?.summary || s?.description || m.skillId)}
  <div class="inline-reason">${draft ? `<label for="reason-${m.skillId}">使用提示 <span>尚未儲存</span></label><textarea id="reason-${m.skillId}" data-reason-input="${m.skillId}" rows="2" maxlength="2000" placeholder="例如：先用這個 Skill 檢查配色與資訊層次">${esc(draft.value)}</textarea><div class="reason-controls"><span>只記錄提示，不會自動執行</span><button class="secondary" data-cancel-reason="${m.skillId}">取消</button><button class="primary" data-save-reason="${m.skillId}">儲存提示</button></div>${draft.error ? `<p class="reason-error" role="alert">${esc(draft.error)}</p>` : ''}` : `<button class="reason-trigger" data-edit-reason="${m.skillId}" aria-label="編輯 ${esc(name)} 的使用提示"><span>使用提示</span><span>${esc(m.reason) || '新增使用提示…'}</span><span class="reason-edit-label">編輯</span></button>`}</div></div>
  <details class="pack-more"><summary aria-label="${esc(name)} 的更多操作">⋯</summary><div class="pack-more-options"><button data-move="${i}" data-direction="-1" ${i===0?'disabled':''}>上移</button><button data-move="${i}" data-direction="1" ${i===p.members.length-1?'disabled':''}>下移</button><button class="remove-member" data-remove="${m.skillId}">從套組移除</button><small>私人收藏仍會保留</small></div></details></article>`;
}
function packsPage() {
  const p = pack();
  return `<div class="packs-view"><div class="heading"><div><h1>任務套組</h1><p>把常用的方法放在一起，為下一次工作做好準備。</p></div><button class="primary" data-action="new-pack">${icon('plus')}建立套組</button></div>${!p ? '<div class="empty-state"><h2>建立你的第一個任務套組</h2><p>從私人收藏挑選成員，記下適合的任務與使用提示。</p><button class="primary" data-action="new-pack">＋ 建立套組</button></div>' : `<div class="packs-layout"><div class="pack-list">${state.packs.map(k => `<button class="pack-card ${k.id === p.id ? 'active' : ''}" data-pack="${k.id}" aria-current="${k.id === p.id}"><div class="pack-top"><span class="pack-icon">${icon('packs')}</span><h3>${esc(k.name)}</h3></div><p>${esc(k.purpose.slice(0,70)) || '尚未填寫用途'}</p><footer><span>${k.members.length} 個 Skills</span><span>${shortDate(k.updatedAt)}</span></footer></button>`).join('')}<button class="create-pack" data-action="new-pack">＋ 建立自己的任務套組</button></div>
  <section class="pack-editor"><div class="pack-editor-head"><div><div class="eyebrow">我的任務套組</div><h2>${esc(p.name)}</h2><p>${esc(p.purpose) || '記下這個套組適合的任務。'}</p></div><div class="actions"><button class="primary" data-action="preview-pack">安裝／同步套組</button><details class="pack-more"><summary aria-label="套組更多操作">⋯</summary><div class="pack-more-options"><button data-action="edit-pack">編輯名稱與用途</button><button class="remove-member" data-action="delete-pack">刪除套組</button></div></details></div></div>
  <div class="pack-editor-body">${(state.deployments || []).some(d=>d.packId===p.id) ? deploymentCards(state.deployments.filter(d=>d.packId===p.id)) : ''}<div class="subheading"><h3>套組成員 <span> / ${p.members.length}</span></h3><button class="secondary" data-action="add-members">＋ 從收藏加入</button></div><div class="compact-members">${p.members.map((m,i)=>memberRow(p,m,i)).join('') || '<div class="empty-row">從收藏加入第一個 Skill。</div>'}</div><p class="helper">順序與使用提示會儲存，但不代表工具會自動依序執行。</p></div>
  <div class="pack-editor-footer"><span>${p.members.some(m=>reasonDrafts.has(reasonKey(p.id,m.skillId))) ? '有使用提示尚未儲存' : '已儲存於本機 · '+shortDate(p.updatedAt)}</span><span>${p.members.length} 個 Skills</span></div></section></div>`}</div>`;
}

function deploymentCards(deployments) {
  return `<section class="deployment-list"><h3>已追蹤的套組配置</h3>${deployments.length ? deployments.map(d=>{
    const p = state.packs.find(p=>p.id===d.packId), index = state.deployments.indexOf(d);
    const contentChanged = d.members.some(m=>skill(m.skillId)?.installations.some(i=>i.destination===d.target+'/'+m.name && i.status!=='current'));
    return `<div class="deployment-row"><div><strong>${esc(p?.name || d.packName)}</strong><p>${toolNames[d.tool]} · ${d.scope==='user'?'全域':esc(state.projects.find(p=>p.path===d.project)?.name || d.project)} · 已追蹤 ${d.members.length} 個 · ${d.conflicts ? '有衝突待處理' : contentChanged ? '安裝內容有差異，請預覽同步' : p?.revision===d.revision ? '已記錄同步' : '套組已調整，請預覽同步'}</p></div><div class="actions"><button class="secondary" data-sync-deployment="${index}">預覽同步</button><button class="quiet" data-detach-deployment="${index}">解除套組配置</button></div></div>`;
  }).join('') : '<p class="helper">尚未追蹤套組來源。從「安裝任務套組」預覽並確認後開始追蹤；既有舊檔不會自動移除。</p>'}</section>`;
}
function beginPackSync(packId, target, detach = false) {
  const p = state.packs.find(p=>p.id===packId);
  state.locationPickerActive=false;state.installPackId=packId; state.installDetach=detach; state.installOrigin=null;
  state.installDraft={tool:target.tool,scope:target.scope,project:target.project || ''};
  const existing = (state.deployments || []).find(d=>d.packId===packId && d.target===target.target);
  preview(detach ? existing?.members.map(m=>m.skillId) || [] : p?.members.map(m=>m.skillId) || [],true);
}
function toolsPage() {
  const isProject = state.scope === 'project', config = state.projectConfig;
  const allRows = isProject ? (config?.items || []) : state.skills.flatMap(s => s.installations.filter(i => i.tool === state.tool && i.scope === 'user').map(i => ({ ...i, name: s.name }))).concat((state.detachedInstalls || []).filter(i=>i.tool===state.tool && i.scope==='user' && !state.skills.some(s=>s.installations.some(r=>r.destination===i.destination))));
  const statusLabels = { current: '內容一致', different: '與收藏內容不同', missing: '目錄不存在', uncollected: '尚未收錄', unreadable: '無法比對' };
  const q = state.configQuery.trim().toLowerCase();
  const rows = allRows.filter(i => (!q || i.name.toLowerCase().includes(q)) && (!state.configStatus || i.status === state.configStatus));
  const filtered = Boolean(q || state.configStatus);
  const projectName = state.projects.find(p => p.path === state.project)?.name || state.project.split('/').filter(Boolean).pop();
  const root = isProject ? config?.target : state.targets[state.tool];
  const empty = !isProject ? '沒有已記錄的全域配置。' : state.projectLoading ? '正在讀取專案配置…' : state.projectError ? state.projectError : !config ? '選擇已加入的專案，或加入資料夾以查看配置。' : !config.exists ? '此專案尚未建立此工具的 Skills 目錄。可以從收藏或任務套組安裝。' : '此專案的 Skills 目錄目前沒有項目。';
  return `<div class="heading"><div><h1>工具配置</h1><p>確認安裝目標，再查看 Skills 與內容狀態。</p></div></div><div class="config-wrap">
  <section class="configuration-target" aria-label="目前配置目標">
    <div class="target-summary"><span class="scope-badge">${isProject ? '指定專案' : '全域配置'}</span><h2>${esc(toolNames[state.tool])}<span aria-hidden="true"> / </span>${esc(isProject ? projectName || '尚未選擇專案' : '所有專案共用')}</h2><p>${isProject ? '只查看此專案目錄內的 Skills；不包含全域與上層目錄。' : '這是使用者層級的安裝位置；各專案也可能有自己的配置。'}</p></div>
    <div class="target-controls"><label>目標工具<select id="target-tool">${Object.entries(toolNames).map(([v,n]) => `<option value="${v}" ${state.tool === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label><label>安裝範圍<select id="target-scope"><option value="user" ${!isProject ? 'selected' : ''}>全域 · 所有專案</option><option value="project" ${isProject ? 'selected' : ''}>指定專案</option></select></label></div>
    ${isProject ? `<div class="project-selector"><label class="field">我的專案 · ${state.projects.length} 個<select id="saved-project"><option value="">選擇已加入的專案</option>${state.projects.map(p => `<option value="${esc(p.path)}" ${p.path === state.project ? 'selected' : ''}>${esc(p.name)} — ${esc(p.path)}</option>`).join('')}</select></label><button class="secondary" data-action="add-project">＋ 選擇資料夾</button><button class="quiet" data-action="remove-project" ${state.projects.some(p => p.path === state.project) ? '' : 'disabled'}>從清單移除</button></div>` : ''}
    <div class="target-location">${isProject && state.project ? `<div><span>專案資料夾</span><code>${esc(state.project)}</code></div>` : ''}<div><span>安裝根目錄</span>${root ? `<code>${esc(root)}</code>` : `<span>${state.projectLoading ? '讀取中…' : '選擇專案並成功讀取後顯示'}</span>`}</div></div>
  </section>
  ${deploymentCards((state.deployments || []).filter(d=>d.target===root))}<section class="config-panel"><div class="config-panel-head"><h2>${isProject ? '專案 Skills' : '全域 Skills'} <span>${allRows.length} 個項目</span></h2><div class="actions"><button class="secondary" data-action="refresh-tools">重新檢查</button><button class="secondary" data-action="install-from-library">從收藏安裝</button><button class="primary" data-action="choose-preview-pack">安裝任務套組</button></div></div>
  <div class="config-filters"><label class="search">${icon('search')}<input id="config-search" aria-label="搜尋已安裝的 Skill" placeholder="搜尋 Skill 名稱…" value="${esc(state.configQuery)}"></label><label class="status-filter">狀態<select id="config-status"><option value="">全部狀態（${allRows.length}）</option>${Object.entries(statusLabels).map(([value,label]) => `<option value="${value}" ${state.configStatus === value ? 'selected' : ''}>${label}（${allRows.filter(i => i.status === value).length}）</option>`).join('')}</select></label><button class="quiet" data-action="reset-config-filters" ${filtered ? '' : 'disabled'}>清除篩選</button></div>
  <p class="config-result-count" role="status" aria-live="polite">${state.projectLoading && isProject ? '正在讀取專案配置…' : `顯示 ${rows.length} / ${allRows.length} 個 Skill`}</p>
  <table class="config-table compact-config"><thead><tr><th>SKILL</th><th>目前狀態</th></tr></thead><tbody>${rows.map(i => `<tr><td><strong>${esc(i.name)}</strong><details class="installation-path"><summary>查看完整路徑</summary><code>${esc(i.destination)}</code></details></td><td><span class="status ${i.status === 'current' ? 'good' : 'warning'}">${statusLabels[i.status] || '未知狀態'}</span>${i.message ? `<small>${esc(i.message)}</small>` : ''}</td></tr>`).join('')}</tbody></table>
  ${rows.length ? '' : `<div class="empty-row" ${state.projectError && isProject ? 'role="alert"' : ''}>${esc(allRows.length && filtered ? '沒有符合條件的 Skill，請調整搜尋或狀態篩選。' : empty)}</div>`}
  <div class="config-footnote">${isProject ? '直接讀取專案目錄，包含尚未收錄的項目；不代表工具的完整生效配置。' : '顯示收藏可辨識及已記錄的全域安裝。'}「內容一致」表示與私人收藏相同。讀取不會修改檔案。</div></section></div>`;
}

let projectReadVersion = 0;
async function readProject(project = state.project) {
  const version = ++projectReadVersion, tool = state.tool;
  state.project = project.trim(); state.projectConfig = null; state.projectError = ''; state.projectLoading = true; render();
  try {
    const result = await api('project-configuration', { tool, project: state.project });
    if (version !== projectReadVersion) return;
    state.projectConfig = result; state.project = result.project;
    try { localStorage.setItem('skillshub.lastProject', result.project); } catch {}
  } catch (error) { if (version === projectReadVersion) state.projectError = '無法讀取專案：' + error.message; }
  finally { if (version === projectReadVersion) { state.projectLoading = false; render(); } }
}
try { state.project = localStorage.getItem('skillshub.lastProject') || ''; } catch {}
function bindInputs() {
  if ($('config-search')) $('config-search').oninput = e => { const position = e.target.selectionStart; state.configQuery = e.target.value; render(); $('config-search').focus(); $('config-search').setSelectionRange(position, position); };
  if ($('config-status')) $('config-status').onchange = e => { state.configStatus = e.target.value; render(); $('config-status').focus(); };
  if ($('saved-project')) $('saved-project').onchange = e => { if (e.target.value) readProject(e.target.value); else { ++projectReadVersion; state.project = ''; state.projectConfig = null; state.projectError = ''; state.projectLoading = false; render(); } };
  if ($('search')) $('search').oninput = e => { const position = e.target.selectionStart; state.query = e.target.value; render(); $('search').focus(); $('search').setSelectionRange(position, position); };
  if ($('tag-filter')) $('tag-filter').onchange = e => { state.tag = e.target.value; render(); };
  if ($('source-filter')) $('source-filter').onchange = e => { state.source = e.target.value; render(); };
  if ($('select-all')) $('select-all').onchange = e => { currentSkills().forEach(s => e.target.checked ? state.selected.add(s.id) : state.selected.delete(s.id)); render(); };
  if ($('target-tool')) $('target-tool').onchange = e => { state.tool = e.target.value; state.projectConfig = null; if (state.scope === 'project' && state.project) readProject(); else render(); };
  if ($('target-scope')) $('target-scope').onchange = e => { state.scope = e.target.value; if (state.scope === 'project' && state.project) readProject(); else render(); };
}
function modal(title, body, footer = '', eyebrow = 'PERSONAL WORKSPACE') {
  $('modal').classList.remove('pack-picker-dialog', 'install-dialog');
  $('modal').innerHTML = `<div class="modal-head"><div><div class="eyebrow">${eyebrow}</div><h2>${title}</h2></div><button class="icon-button" data-action="close" aria-label="關閉">${icon('close')}</button></div><div class="modal-body">${body}<p id="modal-error" role="alert" hidden></p></div><div class="modal-footer"><button class="secondary" data-action="close">關閉</button>${footer}</div>`;
  if (!$('modal').open) $('modal').showModal();
  $('modal').querySelector('[data-action=close]').focus();
}
function showError(error) { if ($('modal').open && $('modal-error')) { $('modal-error').textContent = error.message; $('modal-error').hidden = false; } else toast(error.message); }
async function write(route, body) {
  state.busy = true; document.body.classList.add('saving');
  if ($('modal-error')) $('modal-error').hidden = true;
  try { return await api(route, body); }
  finally { state.busy = false; document.body.classList.remove('saving'); }
}
function acceptPack(p) { const index = state.packs.findIndex(k => k.id === p.id); if (index < 0) state.packs.push(p); else state.packs[index] = p; state.pack = p.id; render(); }
async function persistPack(p) { const saved = await write('packs/save', p); acceptPack(saved); return saved; }
function packForm(existing, members = []) {
  state.packDraft = existing ? structuredClone(existing) : { name: '', purpose: '', members };
  const p = state.packDraft;
  modal(existing ? '編輯套組用途' : '建立任務套組', `<label class="field">套組名稱<input id="pack-name" maxlength="80" value="${esc(p.name)}" placeholder="例如：開發前規劃"></label><label class="field">什麼時候使用<textarea id="pack-purpose" rows="3" maxlength="5000">${esc(p.purpose)}</textarea></label><p>${p.members.length} 個成員${members.length ? '會一併加入新套組' : ''}</p>`, '<button class="primary" data-action="save-pack">儲存套組</button>');
}
function pickPack(ids) {
  state.pendingIds = ids;
  if (!state.packs.length) { packForm(null, ids.map(skillId => ({ skillId, reason: '' }))); return; }
  modal('加入任務套組', `<p>將 ${ids.length} 個選取的 Skill 加入套組，相同成員會略過。</p>${state.packs.map((p, i) => `<label class="choice-row"><input type="radio" name="pack-choice" value="${p.id}" ${i ? '' : 'checked'}><div>${esc(p.name)}<small>${p.members.length} 個 Skills</small></div></label>`).join('')}`, '<button class="secondary" data-action="new-pack-selected">建立新套組</button><button class="primary" data-action="confirm-add-pack">加入套組</button>');
}
async function folderPicker(location, forInstall = false) {
  const data = await write('folders', { path: location });
  state.folderChoice = data.path; state.folderForInstall = forInstall;
  modal('選擇專案資料夾', `${forInstall ? installSteps(2) + installContext(state.pendingIds,state.installDraft,installPackName()) : ''}<p>瀏覽本機資料夾，選擇後會加入專案清單。</p><div class="actions"><button class="secondary" data-folder="${esc(data.home)}">個人資料夾</button><button class="secondary" data-folder="${esc(data.parent)}" ${data.parent === data.path ? 'disabled' : ''}>↑ 上一層</button></div><p class="folder-path">${esc(data.path)}</p><div class="folder-list">${data.folders.map(f => `<button class="folder-row" data-folder="${esc(f.path)}">${icon('folder')}${esc(f.name)}<span>›</span></button>`).join('') || '<p class="helper">這個資料夾沒有可瀏覽的子資料夾。</p>'}</div><details><summary>直接指定路徑（選填）</summary><label class="field">資料夾路徑<input id="folder-path" value="${esc(data.path)}"></label><button class="secondary" data-action="browse-path">前往</button></details>`, `${forInstall ? '<button class="secondary" data-action="preview-again">← 返回安裝目標</button>' : ''}<button class="primary" data-action="save-project-folder">選擇此資料夾並加入</button>`);
  if (forInstall) $('modal').classList.add('install-dialog');
}
function installProjectOptions(selected) {
  return '<option value="">請選擇專案</option>' + (selected && !state.projects.some(p=>p.path===selected) ? `<option value="${esc(selected)}" selected>${esc(selected)}</option>` : '') + state.projects.map(p => `<option value="${esc(p.path)}" ${p.path === selected ? 'selected' : ''}>${esc(p.name)} — ${esc(p.path)}</option>`).join('');
}
function installContext(ids, target = state.installDraft || state, packName = '', verified = false) {
  const project = target.project || '', isProject = target.scope === 'project';
  const projectName = state.projects.find(p=>p.path===project)?.name || project.split('/').filter(Boolean).pop();
  const root = target.target || (isProject ? (project ? project.replace(/\/$/,'') + (target.tool === 'codex' ? '/.agents/skills' : '/.claude/skills') : '') : state.targets[target.tool]);
  return `<section class="install-context" aria-label="本次安裝摘要"><div class="install-context-selection"><span class="context-label">已選內容</span><strong>${packName ? esc(packName)+' · ' : ''}${ids.length} 個 Skill</strong>${ids.length ? `<span class="chosen-names">${ids.slice(0,3).map(id=>esc(skill(id)?.name || id)).join('、')}${ids.length > 3 ? ' ＋' + (ids.length-3) + ' 個' : ''}</span><details class="selected-skills"><summary>查看完整清單</summary><ul>${ids.map(id=>`<li>${esc(skill(id)?.name || id)}</li>`).join('')}</ul></details>` : `<small>${state.installDetach ? '將檢查先前配置並解除套組關聯' : state.installPackId ? '套組目前無成員，將比較先前配置' : '請先選擇要安裝的內容'}</small>`}</div><div class="install-context-target"><span class="context-label">${verified ? '已檢查的安裝目標' : '預選安裝目標'}</span><strong>${esc(toolNames[target.tool])} · ${isProject ? '指定專案' : '全域'}</strong><span>${esc(isProject ? projectName || '尚未選擇專案' : '所有專案共用')}</span><code>${esc(root || '選擇專案後顯示安裝位置')}</code></div></section>`;
}
function installPackName() { return state.installPackId ? state.packs.find(p=>p.id===state.installPackId)?.name || '' : ''; }
function fileChangeList(changes) {
  return `<ul class="file-diff-list">${changes.map(c=>`<li><span>${{add:'新增',update:'修改',remove:'刪除'}[c.action]}</span><code>${esc(c.name)}</code></li>`).join('')}</ul>`;
}
async function showInstallPreview(draft) {
    state.installDraft = draft;
    const plan = await write('plan', {...draft, packId: state.installPackId || null, detach: Boolean(state.installDetach), linkExisting: true});
    if (plan.ids) state.pendingIds = plan.detach ? plan.previous.members.map(m=>m.skillId) : plan.ids;
    state.installPlan = plan;
    const adds = plan.items.filter(i => i.action === 'add').length;
    const links = plan.items.filter(i=>i.action==='link').length;
    const updates = plan.items.filter(i=>i.action==='update').length;
    const same = plan.items.filter(i => i.action === 'same').length;
    const conflicts = plan.items.filter(i => i.action === 'conflict').length;
    const removes = plan.items.filter(i=>i.action==='remove').length;
    modal(state.installDetach ? '確認解除套組配置' : plan.packId ? '確認套組同步' : '確認安裝變更', `${installSteps(3)}${installContext(state.pendingIds,{...draft,...plan},installPackName(),true)}${plan.warning ? `<p class="sync-warning">${esc(plan.warning)}</p>` : ''}<div class="change-totals"><span>新增 <b>${adds}</b></span><span>更新 <b>${updates}</b></span>${links ? `<span>沿用 <b>${links}</b></span>` : ''}<span>略過 <b>${same}</b></span><span class="conflict-total">衝突 <b>${conflicts}</b></span>${plan.packId ? `<span>移除 <b>${removes}</b></span><span>保留 <b>${plan.items.filter(i=>i.action==='keep').length}</b></span>` : ''}</div>${changeGroups(plan.items)}<p class="helper">${plan.packId ? '確認後更新套組關聯，執行標示的新增、更新與移除。移除項目會保留還原備份。' : '更新前備份舊版並沿用管理歸屬；新增安裝會記錄單獨使用關聯。'}預覽後若內容或套組變更，必須重新預覽。</p>`, `<button class="secondary" data-action="preview-again">← 上一步</button><button class="primary" data-action="confirm-install" ${plan.canApply ? '' : 'disabled'}>${state.installDetach ? '確認解除配置' : plan.packId ? `確認同步（新增 ${adds} · 更新 ${updates} · 移除 ${removes}）` : `確認安裝／更新 ${adds + updates + links} 個 Skill`}</button>`, '安裝 Skills');
    $('modal').classList.add('install-dialog');
}
async function chooseInstallationTarget(ids, packId = null) {
  const {targets}=await write('installation-targets',{ids,packId});
  state.locationPickerActive=true;state.locationChoices=targets;state.pendingIds=ids;state.installPackId=packId;state.installDetach=false;state.installOrigin=null;
  modal('要更新哪個位置？', `<p>${esc(packId?state.packs.find(p=>p.id===packId)?.name:ids.map(id=>skill(id)?.name).join('、'))}</p><p>已安裝在專案內的 Skill 可以直接更新，不需要先安裝到全域。</p><div class="location-choices">${targets.map((t,index)=>`<label class="choice-row"><input type="radio" name="existing-location" value="${index}" ${t.error?'disabled':''}><div><strong>${esc(toolNames[t.tool])} · ${t.scope==='user'?'全域':esc(state.projects.find(p=>p.path===t.project)?.name || t.project.split('/').pop())}</strong><small>${esc(t.error || `${t.installed.length} 個已安裝的 Skills`)}</small><small>${esc(t.project || '所有專案共用')}</small></div></label>`).join('') || '<p class="helper">尚未找到已安裝的位置，可安裝到新位置。若專案未加入清單，請先到工具配置加入。</p>'}</div><p class="helper">檢查全域、已加入的專案與既有紀錄；每個位置分別預覽確認。</p>`, '<button class="secondary" data-action="install-new-location">安裝到新位置</button><button class="primary" data-action="update-existing-location" disabled>預覽這個位置的變更 →</button>');
  $('modal').classList.add('install-dialog');
  document.querySelectorAll('[name=existing-location]').forEach(r=>r.onchange=()=>{document.querySelector('[data-action="update-existing-location"]').disabled=false;});
}
async function lifecycleAction(action, el) {
  if (action==='remove-collection') {
    const plan=await write('collection/remove-preview',{id:state.focus});state.removalPlan=plan;
    modal('移除收藏並解除安裝？', `<h3>${esc(plan.skill.name)}</h3><p>收藏副本、筆記與下方列出的安裝都會先備份再移除。若本機來源就是安裝位置，也會一併備份移除；遠端 GitHub 不受影響。</p><h3>會從 ${plan.packs.length} 個套組移除</h3>${plan.packs.length ? '<ul>'+plan.packs.map(p=>'<li>'+esc(p.name)+'</li>').join('')+'</ul>' : '<p>目前沒有套組使用這個 Skill。</p>'}<h3>解除安裝 ${plan.installations.filter(i=>i.action==='remove').length} 個位置 · 保留 ${plan.installations.filter(i=>i.action==='keep').length} 個衝突</h3>${plan.installations.map(i=>`<div class="change-row"><div>${esc(toolNames[i.tool])} · ${i.scope==='user'?'全域':'專案'}<small>${esc(i.destination)}</small><small>${esc(i.message)}</small></div><span>${{remove:'將解除安裝',keep:'衝突保留',missing:'已不存在'}[i.action]}</span></div>`).join('')}<p class="sync-warning">會一併解除上方列出的安裝，先備份再移除。手動修改、無法比對或其他收藏版本共用的檔案保留。檢查範圍包含全域、已加入的專案及既有安裝紀錄；未加入的專案無法自動發現。</p>`, '<button class="primary" data-action="confirm-remove-collection">確認移除收藏並解除安裝</button>');
    $('modal').classList.add('install-dialog');return true;
  }
  if (action==='confirm-remove-collection') {
    const result=await write('collection/remove-confirm',{token:state.removalPlan.token});state.removalPlan=null;state.details.delete(result.removed);state.selected.delete(result.removed);
    for(const key of reasonDrafts.keys())if(key.endsWith(':'+result.removed))reasonDrafts.delete(key);
    await load();go('library');modal('已從私人收藏移除',`<p>${esc(result.name)} 已移除，並從 ${result.packs} 個套組移出。已解除 ${result.uninstalled.length} 個安裝，保留 ${result.kept.length} 個衝突。</p>${result.kept.map(i=>`<div class="change-row"><div>${esc(i.destination)}<small>${esc(i.message)}</small></div></div>`).join('')}${result.uninstalled.length ? `<details><summary>查看安裝備份</summary>${result.uninstalled.map(i=>`<p><code>${esc(i.backup)}</code></p>`).join('')}</details>` : ''}<details><summary>查看收藏備份位置</summary><code>${esc(result.backup)}</code></details>`);return true;
  }
  if (action==='rechoose-location') {await chooseInstallationTarget(state.pendingIds,state.installPackId);return true;}
  if (action==='update-existing-location') {
    const target=state.locationChoices[Number(document.querySelector('[name=existing-location]:checked')?.value)];if(!target || target.error)throw new Error('請選擇安裝位置');
    state.installDraft={tool:target.tool,scope:target.scope,project:target.project};await showInstallPreview({ids:[...state.pendingIds],...state.installDraft});return true;
  }
  if (action==='install-new-location') {state.installDraft={tool:state.tool,scope:state.project?'project':state.scope,project:state.project};preview(state.pendingIds,true);return true;}
  if (action==='check-source') {
    const id=state.focus;el.textContent='正在檢查來源…';
    try {
      const plan=await write('source/preview',{id});state.sourcePlan=plan;
      modal('來源更新預覽', `<div class="summary-box"><strong>${esc(plan.name)}</strong><p>${esc(plan.source.location)}</p>${plan.source.subdirectory?`<code>${esc(plan.source.subdirectory)}</code>`:''}<p>收藏 ${esc(plan.before.slice(0,12))} → 來源 ${esc(plan.after.slice(0,12))}</p>${plan.source.revision?`<p>Commit ${esc(plan.oldRevision.slice(0,12))} → ${esc(plan.source.revision.slice(0,12))}</p>`:''}</div><p>這一步只更新私人收藏，工具端保持原狀。保留標籤、筆記與套組關聯，舊版會備份。</p><p class="sync-warning">更新收藏後，可直接選擇已安裝的全域或專案位置。符合已保存版本的舊安裝可更新，手動修改的內容會保留。</p>${plan.changes.length?fileChangeList(plan.changes):'<p role="status">來源內容與收藏一致，無需更新。</p>'}<p class="helper">確認會套用本次檢查的來源快照；預覽有效 10 分鐘。</p>`, `<button class="primary" data-action="confirm-source" ${plan.canApply?'':'disabled'}>確認更新私人收藏</button>`);
      $('modal').classList.add('install-dialog');
    } finally {el.textContent='檢查來源更新';} return true;
  }
  if (action==='confirm-source') {
    const result=await write('source/confirm',{token:state.sourcePlan.token});state.sourcePlan=null;state.updatedSkill=result.id;state.details.delete(result.id);await load();await loadDetail();
    modal('私人收藏已更新', `<p>已保存新版，套組成員與個人筆記保持不變。下一步可選擇工具與範圍，預覽更新已安裝版本。</p><details><summary>查看舊版備份</summary><code>${esc(result.backup)}</code></details>`, '<button class="primary" data-action="sync-updated-skill">下一步：同步到工具 →</button>');return true;
  }
  if (action==='sync-updated-skill') {await chooseInstallationTarget([state.updatedSkill]);return true;}
  return false;
}

function changeGroups(items) {
  return [['add','新增','將安裝完整 Skill 檔案'],['link','沿用現有安裝','檔案不變；確認後記錄此安裝，後續可更新與移除'],['update','更新','已納管且未被修改；先備份舊版，再更新為收藏內容'],['same','略過','內容相同，維持現有檔案'],['conflict','衝突','保留目標原檔，不覆蓋或合併'],['remove','移除','已不需要且沒有其他使用來源；移出目錄並備份'],['keep','保留','解除此套組關聯，但保留檔案']].sort((a,b)=> items.some(i=>i.action==='remove') ? Number(b[0]==='remove')-Number(a[0]==='remove') : 0).map(([action,label,hint])=>{
    const rows=items.filter(i=>i.action===action);
    if (!rows.length && ['link','update','remove','keep'].includes(action)) return '';
    return `<section class="change-group change-group-${action}" aria-label="${label}項目"><header><h3>${label}<span>${rows.length}</span></h3><p>${hint}</p></header>${rows.length ? rows.map(i=>`<div class="change-item"><strong>${esc(i.name)}</strong>${i.message ? `<p>${esc(i.message)}</p>` : ''}${i.action==='update' && i.managed?.owners.length ? `<p>沿用管理歸屬：${i.managed.owners.map(o=>esc(o==='individual'?'單獨安裝':state.packs.find(p=>p.id===o.slice(5))?.name || '其他套組')).join('、')}</p>` : ''}${i.changes?.length ? `<details><summary>檔案差異 · ${i.changes.length} 個</summary>${fileChangeList(i.changes)}</details>` : ''}<details><summary>查看完整路徑</summary><code>${esc(i.destination)}</code></details></div>`).join('') : '<p class="group-empty">沒有此類項目</p>'}</section>`;
  }).join('');
}
function installSteps(step) {
  const labels = state.installOrigin ? ['選擇內容', '工具與範圍', '預覽並確認'] : ['工具與範圍', '預覽並確認'];
  const current = state.installOrigin ? step : step - 1;
  return `<ol class="install-steps" aria-label="安裝流程">${labels.map((label, i) => `<li ${i + 1 === current ? 'aria-current="step"' : ''}><b>${i + 1}</b>${label}</li>`).join('')}</ol>`;
}
function saveInstallDraft() {
  state.installDraft = { tool: $('preview-tool').value, scope: $('install-scope').value, project: $('install-project').value };
}
function preview(ids, restore = false, origin = null) {
  if (!ids.length && !(restore && state.installPackId)) { toast('請先選擇至少一個 Skill'); return; }
  state.pendingIds = ids;
  state.installPlan = null;
  if (!restore) { state.locationPickerActive=false;state.installOrigin = origin; if (origin !== 'pack') state.installPackId = null; state.installDetach = false; }
  const d = restore ? state.installDraft : { tool: state.tool, scope: state.scope, project: state.project };
  modal(state.installDetach ? '解除套組配置' : state.installPackId ? '同步套組到工具' : '安裝到工具', `${installSteps(2)}<div id="install-context">${installContext(ids,d,installPackName())}</div><p>已選 ${ids.length} 個 Skill。預覽會讀取目標的實際內容，尚不寫入檔案。</p><label class="field">目標工具<select id="preview-tool">${Object.entries(toolNames).map(([id,name])=>`<option value="${id}" ${d.tool===id?'selected':''}>${name}</option>`).join('')}</select></label><label class="field">安裝範圍<select id="install-scope"><option value="user" ${d.scope==='user'?'selected':''}>全域 · 所有專案</option><option value="project" ${d.scope==='project'?'selected':''}>指定專案</option></select></label><div id="project-field" ${d.scope==='project'?'':'hidden'}><label class="field">安裝專案<select id="install-project">${installProjectOptions(d.project)}</select></label><button class="secondary" data-action="install-add-project">＋ 選擇資料夾加入專案</button></div>`, `${state.locationPickerActive ? '<button class="secondary" data-action="rechoose-location">← 選擇其他位置</button>' : ''}${state.installOrigin ? '<button class="secondary" data-action="install-back">← 上一步</button>' : ''}<button class="primary" data-action="show-preview">預覽變更 →</button>`, '安裝 Skills');
  $('modal').classList.add('install-dialog');
  const refreshTarget = () => {
    saveInstallDraft();
    $('project-field').hidden = state.installDraft.scope !== 'project';
    $('install-context').innerHTML = installContext(ids,state.installDraft,installPackName());
    document.querySelector('[data-action="show-preview"]').disabled = state.installDraft.scope === 'project' && !state.installDraft.project;
  };
  ['preview-tool','install-scope','install-project'].forEach(id=>$(id).onchange=refreshTarget);
  refreshTarget();
  if (state.installDetach) { ['preview-tool','install-scope','install-project'].forEach(id=>$(id).disabled=true); document.querySelector('[data-action="install-add-project"]').hidden=true; }
}

async function handleClick(e) {
  const el = e.target.closest('button,[data-select],[data-skill-row]'); if (!el || state.busy) return;
  if (el.dataset.syncDeployment !== undefined || el.dataset.detachDeployment !== undefined) {
    const detach = el.dataset.detachDeployment !== undefined;
    const d = state.deployments[Number(detach ? el.dataset.detachDeployment : el.dataset.syncDeployment)];
    beginPackSync(d.packId,d,detach); return;
  }
  if (el.dataset.folder) { await folderPicker(el.dataset.folder, state.folderForInstall); return; }
  if (el.dataset.screen) { state.filter = 'all'; state.tag = ''; go(el.dataset.screen); return; }
  if (el.dataset.filter) { state.filter = el.dataset.filter; state.tag = ''; go('library'); return; }
  if (el.dataset.tag !== undefined) { state.tag = el.dataset.tag; state.filter = 'all'; go('library'); return; }
  if (el.dataset.focus || el.dataset.skillRow) { state.focus = el.dataset.focus || el.dataset.skillRow; state.detailError = ''; state.detailTab = 'overview'; render(); document.querySelector('[data-focus="' + state.focus + '"]').focus({ preventScroll: true }); if (matchMedia('(max-width:700px)').matches) $('detail-panel').scrollIntoView({ block: 'start' }); await loadDetail(); return; }
  if (el.dataset.select) { const id = el.dataset.select; el.checked ? state.selected.add(id) : state.selected.delete(id); render(); document.querySelector('[data-select="' + id + '"]').focus({ preventScroll: true }); return; }
  if (el.dataset.favorite) { const s = skill(el.dataset.favorite); const result = await write('update', { id: s.id, favorite: !s.favorite }); Object.assign(s, result); render(); return; }
  if (el.dataset.tab) { state.detailTab = el.dataset.tab; renderDetail(); $('detail-tab-' + state.detailTab).focus({ preventScroll: true }); return; }
  if (el.dataset.pack) { state.pack = el.dataset.pack; go('packs'); return; }
  if (el.dataset.editReason) {
    const id = el.dataset.editReason, m = pack().members.find(m=>m.skillId===id);
    reasonDrafts.set(reasonKey(pack().id,id), { value: m.reason, error: '' }); render(); $('reason-'+id).focus(); return;
  }
  if (el.dataset.cancelReason) {
    const id = el.dataset.cancelReason; reasonDrafts.delete(reasonKey(pack().id,id)); render(); document.querySelector('[data-edit-reason="'+id+'"]').focus({preventScroll:true}); return;
  }
  if (el.dataset.saveReason) {
    const id = el.dataset.saveReason, p = structuredClone(pack()), key = reasonKey(p.id,id), draft = reasonDrafts.get(key);
    p.members.find(m=>m.skillId===id).reason = draft.value;
    try { const saved = await write('packs/save',p); reasonDrafts.delete(key); acceptPack(saved); document.querySelector('[data-edit-reason="'+id+'"]').focus({preventScroll:true}); toast('使用提示已儲存'); }
    catch(error) { draft.error = error.message; render(); $('reason-'+id).focus(); }
    return;
  }
  if (el.dataset.move !== undefined) {
    const p = structuredClone(pack()), from = Number(el.dataset.move), to = from + Number(el.dataset.direction);
    if (to < 0 || to >= p.members.length) return;
    [p.members[from], p.members[to]] = [p.members[to], p.members[from]];
    await persistPack(p); return;
  }
  if (el.dataset.remove) { const p = structuredClone(pack()); p.members = p.members.filter(m => m.skillId !== el.dataset.remove); await persistPack(p); toast('已從套組移除，私人收藏仍保留'); return; }
  if (el.dataset.reason !== undefined) { state.packDraft = structuredClone(pack()); state.reasonIndex = Number(el.dataset.reason); const m = state.packDraft.members[state.reasonIndex]; modal('編輯使用提示', `<p>${esc(skill(m.skillId)?.name)}</p><label class="field">為什麼放在這個套組？<textarea id="member-reason" rows="3" maxlength="2000">${esc(m.reason)}</textarea></label>`, '<button class="primary" data-action="save-reason">儲存提示</button>'); return; }
  const action = el.dataset.action;
  if (await lifecycleAction(action,el)) return;
  if (action === 'close') $('modal').close();
  if (action === 'retry-detail') await loadDetail();
  if (action === 'add-project') await folderPicker(undefined);
  if (action === 'browse-path') await folderPicker($('folder-path').value.trim(), state.folderForInstall);
  if (action === 'install-add-project') {
    state.installDraft = { tool: $('preview-tool').value, scope: $('install-scope').value, project: $('install-project').value };
    await folderPicker(undefined, true);
  }
  if (action === 'save-project-folder') {
    const p = await write('projects/add', { path: state.folderChoice });
    if (!state.projects.some(x => x.id === p.id)) state.projects.push(p);
    state.project = p.path;
    if (state.folderForInstall) { state.installDraft.project = p.path; preview(state.pendingIds, true); }
    else { $('modal').close(); state.scope = 'project'; await readProject(p.path); }
    toast('專案已儲存，可以隨時切換');
  }
  if (action === 'remove-project') {
    const p = state.projects.find(p => p.path === state.project); if (!p) return;
    state.removeProjectId = p.id;
    modal('從清單移除專案？', '<p>只移除清單中的紀錄，專案資料夾與已安裝的 Skills 都會保留。</p>', '<button class="primary" data-action="confirm-remove-project">從清單移除</button>');
  }
  if (action === 'confirm-remove-project') {
    await write('projects/remove', { id: state.removeProjectId });
    state.projects = state.projects.filter(p => p.id !== state.removeProjectId);
    ++projectReadVersion; state.project = state.projects[0]?.path || ''; state.projectConfig = null; state.projectError = ''; state.projectLoading = false;
    try { localStorage.setItem('skillshub.lastProject', state.project); } catch {}
    $('modal').close(); if (state.project) await readProject(); else render();
  }
  if (action === 'reset-config-filters') { state.configQuery = ''; state.configStatus = ''; render(); $('config-search').focus(); }
  if (action === 'clear-selected') { state.selected.clear(); render(); }
  if (action === 'reset-filters') { state.query = ''; state.tag = ''; state.source = ''; state.filter = 'all'; render(); }
  if (action === 'edit-metadata') {
    const s = skill(state.focus); state.editId = s.id;
    modal('編輯收藏資訊', `<p>${esc(s.name)} · 不修改原始 SKILL.md</p><label class="field">中文用途／自訂摘要<input id="summary" value="${esc(s.summary || '')}" maxlength="2000"></label><label class="field">什麼時候用<textarea id="use-case" rows="2" maxlength="2000">${esc(s.useCase || '')}</textarea></label><label class="field">標籤（以逗號分隔）<input id="tags" value="${esc(s.tags.join(', '))}"></label><label class="field">我的筆記<textarea id="notes" rows="3" maxlength="10000">${esc(s.notes)}</textarea></label>`, '<button class="primary" data-action="save-metadata">儲存收藏資訊</button>');
  }
  if (action === 'save-metadata') {
    const updated = await write('update', { id: state.editId, summary: $('summary').value, useCase: $('use-case').value, tags: $('tags').value.split(/[,，]/), notes: $('notes').value });
    Object.assign(skill(state.editId), updated); $('modal').close(); render(); toast('收藏資訊已儲存');
  }
  if (action === 'new-pack') packForm(null);
  if (action === 'edit-pack') packForm(pack());
  if (action === 'new-pack-selected') packForm(null, state.pendingIds.map(skillId => ({ skillId, reason: '' })));
  if (action === 'save-pack') { const p = { ...state.packDraft, name: $('pack-name').value.trim(), purpose: $('pack-purpose').value.trim() }; if (!p.name) throw new Error('請填寫套組名稱'); await persistPack(p); $('modal').close(); go('packs'); toast('套組已儲存'); }
  if (action === 'save-reason') { const p = state.packDraft; p.members[state.reasonIndex].reason = $('member-reason').value; await persistPack(p); $('modal').close(); toast('使用提示已儲存'); }
  if (action === 'add-focused') pickPack([state.focus]);
  if (action === 'add-to-pack') pickPack([...state.selected]);
  if (action === 'confirm-add-pack') {
    const p = structuredClone(state.packs.find(p => p.id === document.querySelector('[name=pack-choice]:checked').value));
    for (const id of state.pendingIds) if (!p.members.some(m => m.skillId === id)) p.members.push({ skillId: id, reason: '' });
    await persistPack(p); $('modal').close(); toast('已加入套組');
  }
  if (action === 'add-members') {
    state.packDraft = structuredClone(pack());
    modal('從私人收藏加入', `<label class="search">${icon('search')}<input id="member-search" placeholder="搜尋 Skill 名稱或用途" aria-label="搜尋套組候選成員"></label><label class="field">來源<select id="member-source"><option value="">所有來源</option>${[...new Set(state.skills.map(sourceName))].sort().map(source => `<option value="${esc(source)}">${esc(source)}</option>`).join('')}</select></label><p id="member-count" class="helper" role="status"></p><div id="member-options">${state.skills.map(s => `<label class="choice-row" data-member-source="${esc(sourceName(s))}" data-search-text="${esc([s.name, s.summary, s.description, ...s.tags].join(' ').toLowerCase())}"><input type="checkbox" name="member-choice" value="${s.id}" ${pack().members.some(m => m.skillId === s.id) ? 'checked disabled' : ''}><div>${esc(s.name)}<small>${esc(s.summary || s.description)}</small></div></label>`).join('')}</div>`, '<button class="primary" data-action="save-members">加入選取成員</button>');
    const filterMembers = () => {
      const q = $('member-search').value.trim().toLowerCase(), source = $('member-source').value;
      const rows = [...$('member-options').querySelectorAll('[data-search-text]')];
      rows.forEach(row => { row.hidden = !row.dataset.searchText.includes(q) || (source !== '' && row.dataset.memberSource !== source); });
      const shown = rows.filter(row => !row.hidden).length;
      const selected = rows.filter(row => { const checkbox = row.querySelector('input'); return checkbox.checked && !checkbox.disabled; }).length;
      $('member-count').textContent = (shown ? '顯示 ' + shown + ' 個 Skill' : '沒有符合條件的 Skill，請調整來源或搜尋文字') + ' · 已選 ' + selected + ' 個新成員（切換篩選會保留勾選）';
    };
    $('member-search').oninput = filterMembers;
    $('member-source').onchange = filterMembers;
    $('member-options').onchange = filterMembers;
    filterMembers();
  }
  if (action === 'save-members') { const ids = [...document.querySelectorAll('[name=member-choice]:checked:not(:disabled)')].map(c => c.value); if (!ids.length) throw new Error('請選取至少一個新的成員'); const p = state.packDraft; p.members.push(...ids.map(skillId => ({ skillId, reason: '' }))); await persistPack(p); $('modal').close(); toast('成員已儲存'); }
  if (action === 'delete-pack') { state.deleteDraft = structuredClone(pack()); modal('刪除這個套組？', `<p>將刪除「${esc(pack().name)}」的組合與使用提示。私人收藏及工具配置都會保留。</p>`, '<button class="primary" data-action="confirm-delete-pack">刪除套組</button>'); }
  if (action === 'confirm-delete-pack') { const p = state.deleteDraft; await write('packs/delete', { id: p.id, revision: p.revision }); state.packs = state.packs.filter(k => k.id !== p.id); state.pack = state.packs[0]?.id || null; $('modal').close(); render(); toast('套組已刪除，Skills 仍保留'); }
  if (action === 'preview-focused') await chooseInstallationTarget([state.focus]);
  if (action === 'preview-pack') await chooseInstallationTarget(pack().members.map(m=>m.skillId),pack().id);
  if (action === 'install-back') { saveInstallDraft(); state.installPlan = null; }
  if (action === 'choose-preview-pack' || (action === 'install-back' && state.installOrigin === 'pack')) {
    if (action === 'choose-preview-pack') { state.installDraft = null; state.installPackId = null; state.installDetach = false; }
    state.installOrigin = 'pack';
    const selected = state.packs.find(p => p.id === state.installPackId && p.members.length) || state.packs.find(p => p.members.length);
    modal('選擇任務套組', `<ol class="install-steps" aria-label="安裝流程"><li aria-current="step"><b>1</b>選擇套組</li><li><b>2</b>工具與範圍</li><li><b>3</b>預覽並確認</li></ol><div id="install-context"></div><p class="picker-intro">一次準備好這次工作需要的 Skills。選擇套組後，再決定安裝到哪裡。</p><div class="picker-caption">我的套組 <span>${state.packs.length} 個</span></div><div class="install-pack-list" role="radiogroup" aria-label="要安裝的任務套組">${state.packs.map(p => `<label class="install-pack-option ${p.members.length ? '' : 'is-empty'}"><input type="radio" name="preview-pack" value="${p.id}" ${selected?.id === p.id ? 'checked' : ''} ${p.members.length ? '' : 'disabled'} aria-label="${esc(p.name)}，${p.members.length} 個 Skills"><span class="install-pack-icon">${icon('packs')}</span><span class="install-pack-content"><span class="install-pack-title">${esc(p.name)}<span class="install-pack-count">${p.members.length} 個 Skills</span></span><span class="install-pack-purpose">${esc(p.purpose || '尚未填寫套組用途')}</span><span class="install-pack-chips">${p.members.slice(0,5).map(m => `<span>${esc(skill(m.skillId)?.name || '已移除的 Skill')}</span>`).join('')}${p.members.length > 5 ? `<span>＋${p.members.length - 5} 個</span>` : ''}</span>${p.members.length ? '' : '<span class="install-pack-empty">尚無成員，請先到任務套組加入 Skills。</span>'}</span><span class="install-pack-radio" aria-hidden="true"></span></label>`).join('') || '<div class="empty-row">還沒有任務套組，先建立一組常用的 Skills 吧。</div>'}</div><p class="picker-note">此步驟只選擇套組，預覽並確認後才會安裝。</p>`, `<span id="pack-selection-summary" class="pack-selection-summary" role="status"></span><button class="primary" data-action="preview-selected-pack" ${selected ? '' : 'disabled'}>選擇工具與範圍 ${icon('arrow')}</button>`, '安裝任務套組 · 步驟 1 / 3');
    $('modal').classList.add('pack-picker-dialog');
    const updateSelection = () => {
      const id = document.querySelector('[name=preview-pack]:checked')?.value;
      const p = state.packs.find(p => p.id === id);
      $('install-context').innerHTML = installContext(p?.members.map(m=>m.skillId) || [],state.installDraft || state,p?.name || '');
      $('pack-selection-summary').textContent = p ? '已選「' + p.name + '」· ' + p.members.length + ' 個 Skills' : '請先建立有成員的套組';
    };
    document.querySelectorAll('[name=preview-pack]').forEach(input => input.onchange = updateSelection);
    updateSelection();
  }
  if (action === 'preview-selected-pack') {
    const selected = state.packs.find(p => p.id === document.querySelector('[name=preview-pack]:checked')?.value);
    if (!selected?.members.length) { toast('請選擇有成員的任務套組'); return; }
    state.installPackId = selected.id; state.installDetach = false;
    preview(selected.members.map(m => m.skillId), Boolean(state.installDraft), 'pack');
  }
  if (action === 'show-preview') await showInstallPreview({ids:[...state.pendingIds],tool:$('preview-tool').value,scope:$('install-scope').value,project:$('install-project').value.trim()});
  if (action === 'preview-again') preview(state.pendingIds, true);
  if (action === 'confirm-install') {
    const plan = state.installPlan;
    if (!plan) throw new Error('請重新預覽後再安裝');
    state.installPlan = null;
    const result = await write('install', { token: plan.token });
    state.tool = plan.tool; state.scope = plan.scope; state.project = state.installDraft.project;
    // Installation has finished even if the subsequent status refresh fails.
    try { await load(); } catch (error) { toast('安裝結果已取得；配置狀態讀取失敗，請重新整理：' + error.message); }
    if (state.scope === 'project') await readProject();
    go('tools');
    modal('安裝結果', `${installContext(state.pendingIds,{...state.installDraft,...plan},installPackName(),true)}<div class="summary-box">${result.filter(r=>r.status==='installed').length} 個安裝成功 · ${result.filter(r=>r.status==='updated').length} 個已更新並備份 · ${result.filter(r=>r.status==='linked').length} 個沿用現有安裝 · ${result.filter(r=>r.status==='removed').length} 個已移除並備份 · ${result.filter(r=>r.status==='skipped').length} 個略過 · ${result.filter(r=>r.status==='error').length} 個失敗</div>${result.map(r=>`<div class="change-row"><div>${esc(r.name)}<small>${esc(r.destination)}</small><small>${esc(r.status==='installed'?'已保存完整 Skill 與安裝紀錄':r.message)}</small></div><em class="${r.status==='installed'?'':'skip'}">${{installed:'成功',linked:'已沿用',updated:'已更新並備份',removed:'已備份移除',skipped:'保留／略過',error:'失敗'}[r.status]}</em></div>`).join('')}`, '<button class="secondary" data-action="preview-again">重新預覽</button>', '安裝完成');
    $('modal').classList.add('install-dialog');
  }
  if (action === 'install-selected') preview([...state.selected]);

  if (action === 'refresh-tools') { if (state.scope === 'project') await readProject(); else await load(); }
  if (action === 'install-from-library' || (action === 'install-back' && state.installOrigin === 'library')) {
    if (action === 'install-from-library') { state.installDraft = null; state.pendingIds = []; state.installPackId = null; }
    state.installOrigin = 'library';
    modal('選擇要安裝的 Skills', `${installSteps(1)}<div id="install-context">${installContext(state.pendingIds)}</div><label class="search">${icon('search')}<input id="install-search" aria-label="搜尋安裝候選" placeholder="搜尋名稱或用途"></label>${state.skills.map(s=>`<label class="choice-row" data-install-search="${esc([s.name,s.summary,s.description].join(' ').toLowerCase())}"><input type="checkbox" name="install-choice" value="${s.id}" ${state.pendingIds.includes(s.id) ? 'checked' : ''}><div>${esc(s.name)}<small>${esc(s.summary||s.description)}</small></div></label>`).join('')}`, '<button class="primary" data-action="install-picked">選擇工具與範圍 →</button>');
    $('modal').classList.add('install-dialog');
    const updatePicked = () => {
      const ids = [...document.querySelectorAll('[name=install-choice]:checked')].map(el=>el.value);
      $('install-context').innerHTML = installContext(ids);
      document.querySelector('[data-action="install-picked"]').disabled = !ids.length;
    };
    document.querySelectorAll('[name=install-choice]').forEach(input=>input.onchange=updatePicked);
    updatePicked();
    $('install-search').oninput=e=>document.querySelectorAll('[data-install-search]').forEach(row=>row.hidden=!row.dataset.installSearch.includes(e.target.value.trim().toLowerCase()));
  }
  if (action === 'install-picked') preview([...document.querySelectorAll('[name=install-choice]:checked')].map(el=>el.value), Boolean(state.installDraft), 'library');
  if (action === 'import') {
    modal('收錄新的 Skill', `<p>選擇 Skill 的來源，完整保存檔案與來源資訊。相同內容會略過。</p><label class="field">從哪裡收錄<select id="import-type"><option value="github">GitHub 公開儲存庫</option><option value="local">本機資料夾</option></select></label><div id="github-import-fields"><label class="field">GitHub 儲存庫網址<input id="import-github-url" type="url" placeholder="https://github.com/owner/repo"><small>貼上公開儲存庫首頁網址，系統會下載並存入私人收藏，不需要選擇本機資料夾。</small></label><label class="field">儲存庫內的 Skill 資料夾（選填）<input id="import-subdirectory" placeholder="例如 skills/research"><small>留空會從儲存庫根目錄尋找 Skills；只想收錄某個 Skill 時，填入它在儲存庫中的相對路徑。</small></label></div><div id="local-import-fields" hidden><label class="field">本機 Skill 資料夾路徑<input id="import-local-path" placeholder="${esc(state.suggestedImport)}"><small>填入含 SKILL.md 的資料夾，或包含多個 Skills 的資料夾。</small></label></div><div class="helper">會收錄找到的所有有效 Skills（最多掃描三層），目前尚未提供匯入前逐項挑選。</div>`, '<button class="primary" data-action="confirm-import">從 GitHub 收錄</button>');
    $('import-type').onchange = e => {
      const github = e.target.value === 'github';
      $('github-import-fields').hidden = !github; $('local-import-fields').hidden = github;
      document.querySelector('[data-action="confirm-import"]').textContent = github ? '從 GitHub 收錄' : '從本機收錄';
      $('modal-error').hidden = true;
    };
  }
  if (action === 'confirm-import') {
    const type = $('import-type').value;
    const location = $(type === 'github' ? 'import-github-url' : 'import-local-path').value.trim();
    if (!location) throw new Error(type === 'github' ? '請貼上 GitHub 儲存庫網址' : '請填寫本機 Skill 資料夾路徑');
    const button = el; button.textContent = '正在收錄…';
    try {
      const result = await write('import', { type, location, subdirectory: type === 'github' ? $('import-subdirectory').value.trim() : '' });
      await load();
      modal('收錄結果', result.map(r => `<div class="change-row"><div>${esc(r.name)}<small>${esc(r.message || '')}</small></div><span>${{ imported: '已收錄', skipped: '已略過', error: '失敗' }[r.status]}</span></div>`).join(''));
    } finally { button.textContent = type === 'github' ? '從 GitHub 收錄' : '從本機收錄'; }
  }
}
document.addEventListener('keydown', e => {
  if (!e.target.matches('[role="tab"][data-tab]') || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
  e.preventDefault();
  const ids = ['overview','document','source'], i = ids.indexOf(state.detailTab);
  state.detailTab = ids[e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (i + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
  renderDetail(); $('detail-tab-' + state.detailTab).focus({ preventScroll: true });
});
document.addEventListener('input', e => {
  if (!e.target.dataset.reasonInput) return;
  const draft = reasonDrafts.get(reasonKey(pack().id,e.target.dataset.reasonInput));
  if (draft) { draft.value = e.target.value; draft.error = ''; }
});
document.addEventListener('toggle', e => {
  if (!e.target.matches('.pack-more') || !e.target.open) return;
  document.querySelectorAll('.pack-more[open]').forEach(menu=>{if(menu!==e.target)menu.open=false;});
}, true);
document.addEventListener('keydown', e => {
  if(e.key==='Escape') document.querySelectorAll('.pack-more[open]').forEach(menu=>{menu.open=false;menu.querySelector('summary').focus();});
});
document.addEventListener('click', e => {
  document.querySelectorAll('.pack-more[open]').forEach(menu=>{if(!menu.contains(e.target))menu.open=false;});
  handleClick(e).catch(showError);
});
$('modal').addEventListener('cancel', e => { if (state.busy) e.preventDefault(); });
document.addEventListener('keydown', e => { if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && !$('modal').open && $('search')) { e.preventDefault(); $('search').focus(); } });
render();
load().catch(error => { $('workspace').innerHTML = `<div class="empty-state"><h2>無法讀取本機資料</h2><p role="alert">${esc(error.message)}</p><button class="primary" id="retry-load">重新讀取</button></div>`; $('retry-load').onclick = () => location.reload(); });
