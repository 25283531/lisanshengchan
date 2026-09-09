(() => {
  const KEY = 'smart-injection-mes-v1';
  const seed = {
    products: [
      {id:'P750', name:'方形餐盒 750ml', version:'V3 蓝标', loss:1.5, recipes:[['RM-PP-T30','PP-T30 透明注塑料',18.6],['MB-BL-03','食品级蓝色母',0.37]], compatible:['IM-03','IM-05']},
      {id:'PR12', name:'圆形保鲜盒 1.2L', version:'Logo-2026', loss:1.2, recipes:[['RM-PP-T30','PP-T30 透明注塑料',25.1],['MB-WH-01','食品级白色母',0.25]], compatible:['IM-05']},
      {id:'P900', name:'分格便当盒 900ml', version:'V2 黑标', loss:1.8, recipes:[['RM-PP-HM30','PP-HM30 耐热料',29.4],['MB-BK-01','食品级黑色母',0.75]], compatible:['IM-08']}
    ],
    materials: [
      {id:'RM-PP-T30',name:'PP-T30 透明注塑料',stock:4820,safety:1500,unit:'kg'},
      {id:'MB-BL-03',name:'食品级蓝色母',stock:145,safety:50,unit:'kg'},
      {id:'RM-PP-HM30',name:'PP-HM30 耐热料',stock:2060,safety:800,unit:'kg'},
      {id:'MB-WH-01',name:'食品级白色母',stock:85,safety:30,unit:'kg'},
      {id:'MB-BK-01',name:'食品级黑色母',stock:66,safety:25,unit:'kg'}
    ],
    devices: [
      {id:'IM-03',name:'海天 MA2800',molds:['M-750-02','M-500-05'],products:['P750'],rate:1250,supply:'S-01',status:'running'},
      {id:'IM-05',name:'伊之密 UN260',molds:['M-R12-01','M-750-02'],products:['P750','PR12'],rate:980,supply:'S-02',status:'running'},
      {id:'IM-08',name:'震雄 SM350',molds:['M-900-01'],products:['P900'],rate:1100,supply:'S-03',status:'fault'}
    ],
    molds: [{id:'M-750-02',name:'750ml 餐盒模',cavities:4},{id:'M-R12-01',name:'1.2L 保鲜盒模',cavities:2},{id:'M-900-01',name:'900ml 便当盒模',cavities:4}],
    supplyLines: [
      {id:'S-01',name:'透明 PP 主线',recipe:'PP-T30 透明',devices:['IM-03'],busyUntil:'2026-08-30T14:20',interval:60,status:'running'},
      {id:'S-02',name:'有色产品线',recipe:'PP-T30 + 蓝色母 2%',devices:['IM-05'],busyUntil:'2026-08-30T15:10',interval:90,status:'running'},
      {id:'S-03',name:'高温 PP 线',recipe:'PP-HM30 耐热',devices:['IM-08'],busyUntil:'2026-08-30T16:30',interval:120,status:'fault'}
    ],
    faults: [{resource:'IM-08', hours:2.5, note:'液压异常', createdAt:'2026-08-30T14:00'}],
    orders: []
  };
  let state = JSON.parse(localStorage.getItem(KEY) || 'null') || structuredClone(seed);
  const save = () => localStorage.setItem(KEY, JSON.stringify(state));
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = n => Number(n).toLocaleString('zh-CN',{maximumFractionDigits:1});
  function showModal(title, content, onSave){
    const modal=$('#modal'); $('#modalTitle').textContent=title;
    modal.querySelector('.form').innerHTML=content;
    modal.classList.add('show');
    $('#confirm').textContent='保存'; $('#confirm').onclick=()=>{onSave?.(modal);modal.classList.remove('show');save();renderAll();};
  }
  function calculate(productId, qty){
    const p=state.products.find(x=>x.id===productId); const requirements=p.recipes.map(([id,name,g])=>({id,name,kg:qty*g/1000*(1+p.loss/100)}));
    const candidates=state.devices.filter(d=>d.products.includes(p.id)&&d.status!=='fault').map(d=>({d,line:state.supplyLines.find(l=>l.id===d.supply)})).filter(x=>x.line&&x.line.status!=='fault');
    const choice=candidates.sort((a,b)=>new Date(a.line.busyUntil)-new Date(b.line.busyUntil)||b.d.rate-a.d.rate)[0];
    return {p,qty,requirements,total:requirements.reduce((a,b)=>a+b.kg,0),choice, hours:choice?qty/choice.d.rate:null};
  }
  function showPlan(productId='P750',qty=32000){
    const r=calculate(productId,qty), host=$('#materialPlan'); if(!host)return;
    const enough=r.requirements.every(x=>(state.materials.find(m=>m.id===x.id)?.stock||0)>=x.kg);
    if(!r.choice){host.innerHTML='<div class="card list-card"><h3>暂无可行排产方案</h3><p class="tiny">所有兼容设备或供料线均处于故障、维修或不兼容状态。请先处理异常或调整资源配置。</p></div>';return;}
    const add=new Date(r.choice.line.busyUntil); add.setMinutes(add.getMinutes()-30); const finish=new Date(new Date(r.choice.line.busyUntil).getTime()+r.hours*3600000); const change=new Date(finish.getTime()+10*60000);
    host.innerHTML=`<div class="plan-result"><div class="card list-card"><div class="section-head"><div><h3>${esc(r.p.name)} · ${esc(r.p.version)}</h3><p>计划 ${fmt(qty)} 件 · 损耗率 ${r.p.loss}%</p></div><span class="tag ${enough?'':'orange'}">总拌料 ${(r.total/1000).toFixed(3)} 吨</span></div>${r.requirements.map(x=>{const m=state.materials.find(v=>v.id===x.id), ok=m.stock>=x.kg;return `<div class="recipe-line"><b>${esc(x.name)}</b><span>需 ${fmt(x.kg)} kg</span><span style="color:${ok?'var(--brand)':'var(--red)'}">库存 ${fmt(m.stock)} kg</span></div>`}).join('')}<p class="tiny">${enough?'库存充足；确认排产后将在开工时预占用料，报工后按实际产量自动扣减。':'库存不足：请先入库或调整计划数量。'}</p></div><div class="card list-card"><h3>供料与机台建议</h3><div class="feed"><div class="feed-icon" style="background:var(--brand-pale)">${r.choice.line.id}</div><div><b>推荐 ${esc(r.choice.line.name)} → ${r.choice.d.id}</b><p>当前占用至 ${new Date(r.choice.line.busyUntil).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}，该机台效率 ${fmt(r.choice.d.rate)} 件/小时。</p></div></div><div class="feed"><div class="feed-icon">⏱</div><div><b>建议加料：${add.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</b><p>预计生产 ${r.hours.toFixed(1)} 小时，开工前预留 30 分钟拌料与输送。</p></div></div><div class="feed"><div class="feed-icon" style="background:var(--blue-pale)">↻</div><div><b>建议换料：${change.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</b><p>任务结束后 10 分钟执行，下一次换料需满足 ${r.choice.line.interval} 分钟最小间隔。</p></div></div><button class="btn primary" id="createPlan" ${enough?'':'disabled'}>确认该生产计划</button></div></div>`;
    $('#createPlan')?.addEventListener('click',()=>{state.orders.push({id:'WO-'+String(Date.now()).slice(-5),productId:r.p.id,qty:r.qty,device:r.choice.d.id,line:r.choice.line.id,status:'已排产'});r.requirements.forEach(x=>state.materials.find(m=>m.id===x.id).stock-=x.kg);r.choice.line.busyUntil=finish.toISOString();save();renderAll();alert('生产计划已创建，原料已预占用，供料线占用时间已更新。');});
  }
  function renderMaterials(){const section=$('#materials tbody');if(!section)return;section.innerHTML=state.materials.map(m=>`<tr><td>${esc(m.id)}</td><td><b>${esc(m.name)}</b></td><td>—</td><td>${fmt(m.stock)} ${m.unit}</td><td><span class="tag ${m.stock<m.safety?'orange':''}">${m.stock<m.safety?'低于安全库存':'可用'}</span></td></tr>`).join('');}
  function renderConfig(){const c=$('#config');if(!c)return;const tables=c.querySelectorAll('tbody'); if(tables[1])tables[1].innerHTML=state.materials.map(m=>`<tr><td>${esc(m.name)}</td><td>${fmt(m.stock)} kg</td><td>${fmt(m.safety)} kg</td><td><button class="action-link use-material" data-id="${m.id}">录入用料</button></td></tr>`).join('');if(tables[2])tables[2].innerHTML=state.devices.map(d=>`<tr><td>${d.id}<br><span class="tiny">${esc(d.name)}</span></td><td>${d.molds.join(', ')}</td><td>${d.products.map(id=>state.products.find(p=>p.id===id)?.name).join(' / ')}</td><td>${fmt(d.rate)} 件/小时</td></tr>`).join('');c.querySelectorAll('.use-material').forEach(b=>b.onclick=()=>manualUse(b.dataset.id));}
  function renderResources(){const c=$('#resources'); if(!c)return;c.querySelector('.resource').innerHTML=state.devices.map(d=>`<div class="card"><h3>${d.id} · ${esc(d.name)}</h3><p class="tiny">可用模具：${d.molds.join('、')}</p><div class="meter"><b style="width:${d.status==='fault'?25:86}%;background:${d.status==='fault'?'var(--red)':'var(--brand)'}"></b></div><span class="tiny" style="color:${d.status==='fault'?'var(--red)':'inherit'}">${d.status==='fault'?'故障锁定，不参与排产':'可排产 · '+fmt(d.rate)+' 件/小时'}</span></div>`).join('');}
  function renderAll(){renderMaterials();renderConfig();renderResources();showPlan();}
  function manualUse(id){const m=state.materials.find(x=>x.id===id);showModal('手动录入用料',`<label>原料<input value="${esc(m.name)}" disabled></label><label>本次使用量（kg）<input id="usedKg" type="number" min="0.01" step="0.01" value="10"></label><label>备注<input id="useNote" placeholder="例如：试模、清机损耗"></label>`,()=>{const kg=Number($('#usedKg').value);if(!kg||kg>m.stock){alert('用料数量无效或超过可用库存。');return;}m.stock-=kg;alert('已扣减 '+fmt(kg)+' kg '+m.name+'。');});}
  function addMaterial(){showModal('原料入库',`<label>原料名称<input id="matName" placeholder="例如：食品级红色母"></label><label>入库数量（kg）<input id="matQty" type="number" value="100"></label><label>安全库存（kg）<input id="matSafety" type="number" value="30"></label>`,()=>{const n=$('#matName').value.trim(),q=Number($('#matQty').value);if(!n||!q)return alert('请填写原料名称和有效数量。');state.materials.push({id:'RM-'+Date.now().toString().slice(-5),name:n,stock:q,safety:Number($('#matSafety').value)||0,unit:'kg'});});}
  function addDevice(){showModal('新增注塑设备',`<label>设备编号<input id="devId" placeholder="例如：IM-10"></label><label>设备名称<input id="devName" placeholder="例如：海天 MA2500"></label><label>生产效率（件/小时）<input id="devRate" type="number" value="1000"></label>`,()=>{const id=$('#devId').value.trim(),name=$('#devName').value.trim(),rate=Number($('#devRate').value);if(!id||!name||!rate)return alert('请完整填写设备资料。');if(state.devices.some(d=>d.id===id))return alert('设备编号已存在。');state.devices.push({id,name,molds:[],products:[],rate,supply:'',status:'running'});});}
  function fault(){showModal('提交设备 / 供料线故障',`<label>故障资源<select id="faultResource">${[...state.devices,...state.supplyLines].map(r=>`<option value="${r.id}">${r.id} · ${esc(r.name)}</option>`).join('')}</select></label><label>故障说明<input id="faultNote" value="设备异常待维修"></label><label>预计维修时长（小时）<input id="faultHours" type="number" step="0.5" min="0.5" value="2.5"></label>`,()=>{const id=$('#faultResource').value,h=Number($('#faultHours').value),note=$('#faultNote').value;const dev=state.devices.find(x=>x.id===id),line=state.supplyLines.find(x=>x.id===id);if(dev){dev.status='fault';const linked=state.supplyLines.find(x=>x.id===dev.supply);if(linked)linked.status='fault';}if(line){line.status='fault';line.devices.forEach(i=>{const d=state.devices.find(x=>x.id===i);if(d)d.status='fault';});}state.faults.push({resource:id,hours:h,note,createdAt:new Date().toISOString()});alert('已锁定 '+id+' 及关联资源 '+h+' 小时，智能排产会自动排除这些资源。');});}
  document.addEventListener('DOMContentLoaded',()=>{renderAll();$('#materialCalc')?.addEventListener('click',()=>{showModal('计算物料与供料方案',`<label>产品<select id="planProduct">${state.products.map(p=>`<option value="${p.id}">${esc(p.name)} · ${esc(p.version)}</option>`).join('')}</select></label><label>计划数量（件）<input id="planQty" type="number" min="1" value="32000"></label>`,()=>showPlan($('#planProduct').value,Number($('#planQty').value)));});$('#submitFault')?.addEventListener('click',fault);document.querySelectorAll('[data-action="material"]').forEach(b=>b.onclick=addMaterial);document.querySelectorAll('[data-action="device"]').forEach(b=>b.onclick=addDevice);$('#saveConfig')?.addEventListener('click',()=>{save();alert('基础数据已保存。');});});
  window.MES={state,reset:()=>{localStorage.removeItem(KEY);location.reload();}};
})();

