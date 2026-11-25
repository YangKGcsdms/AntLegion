'use strict';
const $=(s,r=document)=>r.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={overview:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',facts:'<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',world:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',agents:'<rect x="5" y="7" width="14" height="13" rx="3"/><path d="M12 3v4M9 12v2M15 12v2M9 17h6M2 11v5M22 11v5"/>',ops:'<path d="m9 6-6 6 6 6m6-12 6 6-6 6"/>',refresh:'<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',server:'<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',check:'<path d="m5 12 4 4L19 6"/>',arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',back:'<path d="M20 12H4m6 6-6-6 6-6"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',alert:'<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'};
const icon=n=>`<svg class="od-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[n]||paths.info}</svg>`;
const key = 'antlegion-token:' + location.origin;
let authPrompted = false;
let token = ''; try { token = sessionStorage.getItem(key) || ''; } catch {}
const state = { page:'overview', snapshot:null, readAt:0, error:'', busy:false, instance:null, generation:0, query:0, detail:0, worldRequest:0, rows:null, cursors:[0], filter:{type:'',author:'',since:0}, topic:'', world:null };
const navs = [['overview','总览'],['facts','事实流'],['world','世界状态'],['agents','智能体'],['ops','接入与运维']];
const stamp = n => n ? new Date(n * 1000).toLocaleString('zh-CN', {hour12:false}) : '未知';
const code = value => `<pre class="ds-code">${esc(typeof value === 'string' ? value : JSON.stringify(value,null,2))}</pre>`;
const factLink = (id,label) => `<button class="text-link mono" data-fact="${esc(id)}">${esc(label || id)}</button>`;
const empty = text => `<div class="empty" role="status"><p>${esc(text)}</p></div>`;
const head = (title,sub) => `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div></div>`;
function table(rows) {
  if (!rows.length) return empty('没有匹配的事实');
  return `<div class="table-wrap"><table aria-label="事实日志"><colgroup><col style="width:8%"><col style="width:18%"><col style="width:22%"><col style="width:18%"><col style="width:34%"></colgroup><thead><tr><th>序号</th><th>事实类型</th><th>作者</th><th>接收时间</th><th>内容</th></tr></thead><tbody>${rows.map(f => `<tr><td>${factLink(f.id,'#'+f.seq)}</td><td class="mono">${esc(f.type)}</td><td><span class="mono od-truncate" title="${esc(f.author)}">${esc(f.author)}</span></td><td>${esc(stamp(f.recv))}</td><td><button class="summary-button" data-fact="${esc(f.id)}">${esc(JSON.stringify(f.payload ?? {}).slice(0,140))}</button></td></tr>`).join('')}</tbody></table></div>`;
}
async function api(path) {
  const r = await fetch(path,{headers:token ? {Authorization:'Bearer '+token} : {},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
  if (r.status === 401) { const error = new Error('请填写有效的访问令牌'); error.status = 401; throw error; }
  if (!r.ok) throw Error('请求失败（HTTP '+r.status+'）');
  return r.json();
}
function toast(text) { $('#toast').textContent=text; $('#toast').hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>$('#toast').hidden=true,4000); }
function updateTop() {
  $('#address-btn').textContent=location.origin;
  $('#credentials-btn').hidden=!(state.snapshot?.auth_enabled||authPrompted);
  const stale = state.readAt && Date.now()-state.readAt>30000;
  $('#connection-badge').className='badge '+(state.error?'error':state.readAt?'good':'');
  $('#connection-badge').textContent=state.error?'读取失败':state.readAt?'已连接':'连接中';
  $('#last-update').textContent=state.readAt?'更新于 '+new Date(state.readAt).toLocaleTimeString('zh-CN'):'尚未读取';
  $('#refresh-btn').innerHTML=icon('refresh')+(state.busy?'刷新中':'刷新'); $('#refresh-btn').disabled=state.busy;
  $('#connection-banner').hidden=!state.error;
  $('#connection-banner').textContent=state.error+(state.readAt?'；下方可能显示上次的数据':'');
  $('#freshness-note').hidden=!stale;
  $('#freshness-note').textContent='数据超过 30 秒未更新，请刷新或检查连接。';
}
function overview() {
  const d=state.snapshot;
  if (!d) return empty(state.error || '正在读取总线…');
  const metrics=[['日志头序号',d.bus.head_seq,'最近追加的位置'],['事实总数',d.bus.facts,'服务端日志中的事实数量'],['已声明的智能体',d.counts.registered,'有 sys.registry 声明的作者'],['近期有活动',d.counts.recently_active,`最近 ${d.activity_window_sec} 秒有事实，不代表在线`]];
  return head('总览','查看当前总线与最近追加的事实。')+`<div class="metrics">${metrics.map(([t,v,n])=>`<div class="metric od-stat"><span class="metric-label">${t}</span><strong class="metric-value">${v}</strong><span class="metric-note">${n}</span></div>`).join('')}</div>`+
    (d.bus.sig_failures?`<div class="ds-alert warning">服务端恢复校验发现 ${d.bus.sig_failures} 条签名异常，请检查服务信息与签名密钥。</div>`:'')+
    `<section><div class="section-head"><h2>近期事实</h2><button class="text-link" data-nav="facts">查看全部 →</button></div><div class="panel">${table([...d.latest_facts].reverse().slice(0,10))}</div></section><section class="section-gap"><h2>查询当前状态</h2>${queryForm()}</section>`;
}
function factsPage() {
  const f=state.filter;
  return head('事实流','按序号升序读取，每页最多 100 条。类型支持通配符，作者为精确匹配。')+`<form id="filter-form" class="filters"><div class="field"><label for="filter-type">类型</label><input id="filter-type" name="type" placeholder="例如 service.*" value="${esc(f.type)}"></div><div class="field grow"><label for="filter-author">作者</label><input id="filter-author" name="author" value="${esc(f.author)}"></div><div class="field"><label for="filter-since">起始序号（不含）</label><input id="filter-since" name="since" type="number" min="0" step="1" required value="${f.since}"></div><button class="btn primary">查询</button></form><div class="panel">${state.rows===null?empty('正在查询…'):table(state.rows)}<div class="table-footer"><span>第 ${state.cursors.length} 页 · 当前页 ${state.rows?.length ?? 0} 条</span><div class="btns"><button class="btn small" data-prev ${state.cursors.length===1||state.rows===null?'disabled':''}>上一页</button><button class="btn small" data-next ${!state.rows?.length?'disabled':''}>继续读取</button></div></div></div>`;
}
function queryForm() { return `<form id="subject-form" class="query-box"><div class="field"><label for="topic-input">主题</label><input id="topic-input" name="topic" required placeholder="例如 service:api:status" value="${esc(state.topic)}"></div><button class="btn primary">查询</button></form>`; }
function worldPage() {
  const d=state.world;
  return head('世界状态','由服务端按完整日志计算当前值与历史。')+queryForm()+(d?`<section class="state-result"><div class="section-head"><h2>${esc(d.subject)}</h2><span class="mono muted">计算到 #${d.head_seq}</span></div>${d.current?`<p>当前值来源 ${factLink(d.current.id,'#'+d.current.seq)}</p>${code(d.current.payload)}`:empty(d.history.length?'当前无有效值；历史仍然保留':'该主题没有记录')}<p class="small muted">事实被解决不表示主题值已恢复或改变。</p></section><section class="section-gap"><h2>主题历史</h2><div class="panel world-history">${table([...d.history].reverse())}</div></section>`:empty('输入主题，查看当前状态和历史'));
}
function agentsPage() {
  const agents=state.snapshot?.agents;
  return head('智能体','展示日志中观察到的作者；只读且没有声明的客户端无法被发现。')+(!agents?empty('尚未读取作者数据'):!agents.length?empty('尚未观察到作者'):`<div class="panel table-wrap"><table class="agents-table"><thead><tr><th>作者</th><th>注册声明</th><th>关注 / 发布类型</th><th>最近活动</th><th>最近心跳</th></tr></thead><tbody>${agents.map(a=>`<tr><td class="mono wrap">${esc(a.author)}<br><button class="text-link small" data-author="${esc(a.author)}">查看事实（${a.fact_count}）</button></td><td>${a.registration_id?factLink(a.registration_id,'查看声明'):'未声明'}</td><td class="wrap">关注：${esc(a.interests.join(', ')||'未知')}<br>发布：${esc(a.publishes.join(', ')||'未知')}</td><td>${esc(stamp(a.last_seen))}<br>${factLink(a.last_fact_id,'最近事实')}</td><td>${esc(stamp(a.last_heartbeat))}</td></tr>`).join('')}</tbody></table></div><p class="safety-label">活动和心跳是已观察到的记录，不证明当前在线。声明不代表已授予权限。</p>`);
}
function opsPage() {
  const url=JSON.stringify(location.origin);
  const auth=state.snapshot?.auth_enabled;
  const http=`export ANTLEGION_BUS_URL=${url}\ncurl "$ANTLEGION_BUS_URL/facts?since=0&limit=100"${auth?' -H "Authorization: Bearer $ANTLEGION_API_TOKEN"':''}`;
  const cli=`export ANTLEGION_BUS_URL=${url}\n${auth?'# 按部署配置设置 ANTLEGION_API_TOKEN\n':''}alctl read --since 0 --type 'service.*'\nalctl current service:api:status`;
  const sdk=`import { ClientV2, httpTransport } from '@antlegion/bus/client';\nconst client = new ClientV2(httpTransport(${url}${auth?', { token: process.env.ANTLEGION_API_TOKEN }':''}), 'reader@node-1');\nconst current = await client.currentOf('service:api:status');`;
  return head('接入与运维','使用 HTTP、命令行或 Node.js SDK 读取同一份事实日志。')+
    `<section class="panel panel-pad"><h2>HTTP</h2>${code(http)}</section><section class="section-gap"><h2>命令行 alctl</h2>${code(cli)}</section><section class="section-gap"><h2>Node.js SDK</h2>${code(sdk)}</section><section class="section-gap"><h2>服务信息</h2>${code(state.snapshot?.bus||{})}<p class="small muted">签名校验由服务端执行。${auth?'共享访问令牌不绑定作者身份。':'当前实例无需登录。'}</p><a class="text-link" href="/explorer">打开高级事实浏览器 →</a></section>`;
}
function render() {
  $('#nav').innerHTML=navs.map(([id,label],i)=>`<button data-nav="${id}" class="${state.page===id?'active':''}" ${state.page===id?'aria-current="page"':''}>${icon(id)}<span>${label}</span><span class="nav-num">0${i+1}</span></button>`).join('');
  const pages={overview,facts:factsPage,world:worldPage,agents:agentsPage,ops:opsPage};
  $('#main').innerHTML=`<div class="page">${pages[state.page]()}</div>`; updateTop();
}
async function refresh() {
  if(state.busy)return;
  state.busy=true; updateTop();
  const gen=state.generation;
  try {
    const d=await api('/ops/overview'); if(gen!==state.generation)return;
    const restarted=state.instance&&state.instance!==d.instance_id;
    if(restarted) {
      state.query++; state.worldRequest++; state.detail++; state.rows=null; state.world=null;
      state.cursors=[0]; state.filter.since=0;
      if($('#fact-drawer').open)$('#fact-drawer').close();
      toast('总线已重启，请重新查询事实和主题状态');
    }
    state.instance=d.instance_id; state.snapshot=d; state.readAt=Date.now(); state.error='';
    // Do not replace active forms while the user is typing or reviewing a result.
    if(restarted){render();if(state.page==='facts')void search();}
    else if(['overview','agents','ops'].includes(state.page)&&!$('#main').contains(document.activeElement))render();
  } catch(e) { if(gen===state.generation){state.error=e.message;if(!state.snapshot)render();if(e.status===401&&!authPrompted){authPrompted=true;settings();}} }
  finally { state.busy=false; updateTop(); }
}
async function search() {
  const ticket=++state.query,gen=state.generation;
  state.rows=null; render();
  const p=new URLSearchParams({since:String(state.cursors.at(-1)),limit:'100'});
  for(const k of ['type','author'])if(state.filter[k])p.set(k,state.filter[k]);
  try { const rows=await api('/facts?'+p); if(ticket!==state.query||gen!==state.generation)return; state.rows=rows; }
  catch(e) { if(ticket!==state.query||gen!==state.generation)return; state.rows=[]; toast(e.message); }
  if(state.page==='facts')render();
}
async function querySubject(topic) {
  const ticket=++state.worldRequest,gen=state.generation;
  state.topic=topic;state.world=null;state.page='world';render();
  try { const d=await api('/ops/subject?name='+encodeURIComponent(topic)); if(ticket!==state.worldRequest||gen!==state.generation)return;state.world=d;if(state.page==='world')render(); }
  catch(e) { if(ticket===state.worldRequest&&gen===state.generation)toast(e.message); }
}
const refLabels={parent:'前因事实',subject:'主题',claim_of:'认领目标',resolves:'解决目标',release_of:'释放目标',vote:'投票目标',supersedes:'替代目标',tombstones:'撤销目标'};
async function showFact(id) {
  const ticket=++state.detail, gen=state.generation, dlog=$('#fact-drawer');
  if(!dlog.open)state.returnFocus=document.activeElement;
  $('#drawer-header').innerHTML='<div class="drawer-top"><h2 id="fact-title">事实详情</h2><button class="btn small" data-close-fact>关闭</button></div>';
  $('#drawer-content').innerHTML=empty('正在读取事实…');$('#drawer-footer').textContent='';
  if(!dlog.open)dlog.showModal();
  try {
    const d=await api('/ops/fact/'+encodeURIComponent(id));if(ticket!==state.detail||gen!==state.generation)return;
    const f=d.fact, labels={open:'未认领',claimed:'已认领',resolved:'已解决',dead:'已撤销'};
    $('#drawer-content').innerHTML=`<h3 class="wrap">#${f.seq} · ${esc(f.type)}</h3><dl class="details-grid"><dt>作者</dt><dd>${esc(f.author)}</dd><dt>接收时间</dt><dd>${esc(stamp(f.recv))}</dd><dt>事实编号</dt><dd class="mono">${esc(f.id)}</dd><dt>处理状态</dt><dd>${esc(labels[d.lifecycle.state]||d.lifecycle.state)}</dd><dt>持有者</dt><dd>${esc(d.lifecycle.owner||'—')}</dd></dl><h3>内容</h3>${code(f.payload)}<h3>关联目标</h3>${Object.entries(f.refs||{}).map(([k,v])=>`<p class="wrap">${esc(refLabels[k]||k)}：${k==='subject'?`<button class="text-link" data-topic="${esc(v)}">${esc(v)}</button>`:factLink(v)}</p>`).join('')||'<p class="muted">无关联目标</p>'}<section class="section-gap"><h3>前因事实（parent）</h3>${relationList(d.ancestors.filter(x=>x.id!==f.id))}<h3>后续事实（parent）</h3>${relationList(d.descendants)}</section><details class="section-gap"><summary>信任计算结果（阈值 ${d.quorum}）</summary>${code(d.trust)}</details><details class="section-gap"><summary>原始事实 JSON</summary>${code(f)}</details>`;
    $('#drawer-footer').textContent=`计算到日志序号 #${d.head_seq} · 已解决不等于业务状态恢复正常`;
  } catch(e) {if(ticket===state.detail&&gen===state.generation)$('#drawer-content').innerHTML=empty(e.message);}
}
function relationList(rows) {return rows.length?rows.map(f=>`<p class="wrap">${factLink(f.id,'#'+f.seq)} · ${esc(f.type)} · ${esc(f.author)}</p>`).join(''):'<p class="small muted">无记录</p>';}
function settings() {$('#bus-token').value=token;$('#auth-error').textContent='';if(!$('#settings').open)$('#settings').showModal();$('#bus-token').focus();}
function navigate(page) {state.page=page;render();$('#main').focus({preventScroll:true});if(page==='facts'&&state.rows===null)void search();}
document.addEventListener('click',e=>{
  const b=e.target.closest('button'); if(!b)return;
  if(b.dataset.nav)return navigate(b.dataset.nav);
  if(b.dataset.fact)return void showFact(b.dataset.fact);
  if(b.hasAttribute('data-close-fact'))return $('#fact-drawer').close();
  if(b.hasAttribute('data-close-settings'))return $('#settings').close();
  if(b.dataset.topic){$('#fact-drawer').close();return void querySubject(b.dataset.topic);}
  if(b.dataset.author){state.filter={type:'',author:b.dataset.author,since:0};state.cursors=[0];state.page='facts';return void search();}
  if(b.hasAttribute('data-next')){state.cursors.push(state.rows.at(-1).seq);return void search();}
  if(b.hasAttribute('data-prev')){state.cursors.pop();return void search();}
});
document.addEventListener('submit',e=>{
  if(e.target.id==='filter-form'){e.preventDefault();const f=new FormData(e.target);state.filter={type:String(f.get('type')).trim(),author:String(f.get('author')).trim(),since:Number(f.get('since'))};state.cursors=[state.filter.since];void search();}
  if(e.target.id==='subject-form'){e.preventDefault();const topic=String(new FormData(e.target).get('topic')).trim();if(topic)void querySubject(topic);}
});
$('#connect-form').onsubmit=async e=>{
  e.preventDefault();const next=$('#bus-token').value.trim(),prev=token;token=next;
  const button=e.target.querySelector('[type=submit]');button.disabled=true;
  try {const d=await api('/ops/overview');state.generation++;state.query++;state.worldRequest++;state.detail++;state.snapshot=d;state.instance=d.instance_id;state.readAt=Date.now();state.error='';authPrompted=false;state.rows=null;state.world=null;state.cursors=[0];state.filter.since=0;try{sessionStorage.setItem(key,token);}catch{}$('#settings').close();$('#bus-token').value='';render();if(state.page==='facts')void search();}
  catch(e){token=prev;$('#auth-error').textContent=e.message;}finally{button.disabled=false;}
};
$('#fact-drawer').addEventListener('close',()=>{state.detail++;if(state.returnFocus?.isConnected)state.returnFocus.focus();else $('#main').focus();});
$('#address-btn').onclick=()=>state.snapshot?.auth_enabled?settings():navigate('ops');
$('#credentials-btn').onclick=settings;
$('#refresh-btn').onclick=async()=>{await refresh();if(state.page==='facts')await search();else if(state.page==='world'&&state.topic)await querySubject(state.topic);else render();};
$('#help-icon').innerHTML=icon('info');$('#bus-icon').innerHTML=icon('server');
render();void refresh();setInterval(()=>{if(!document.hidden&&!$('#settings').open)void refresh();},5000);
