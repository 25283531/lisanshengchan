/* 注塑生产协同 MES · 管理后台（原生 JS，无构建步骤） */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { token: null, user: null, tenant: null, platform: false, view: 'overview', master: null };

/* ------------------------------- 接口 ------------------------------- */
async function api(method, url, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({ code: 'ERROR', message: '响应解析失败' }));
  if (json.code !== 0) {
    if (json.code === 'MULTI_TENANT') { const e = new Error(json.message); e.extra = json.data; throw e; }
    throw new Error(json.message || '请求失败');
  }
  return json.data;
}
const toast = (msg, kind = '') => {
  const t = $('#toast');
  t.textContent = msg; t.className = `toast ${kind}`; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), 2600);
};

/* ------------------------------- 登录 ------------------------------- */
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  $('#pane-company').classList.toggle('hidden', b.dataset.tab !== 'company');
  $('#pane-platform').classList.toggle('hidden', b.dataset.tab !== 'platform');
  $('#login-err').textContent = '';
}));

$('#btn-login').addEventListener('click', async () => {
  try {
    const d = await api('POST', '/api/auth/login', {
      phone: $('#lg-phone').value.trim(), password: $('#lg-pwd').value,
      tenantCode: $('#lg-code').value.trim() || undefined,
    });
    state.token = d.token; state.user = d.user; state.tenant = d.tenant; state.platform = false;
    boot();
  } catch (e) { $('#login-err').textContent = e.message; }
});

$('#btn-platform-login').addEventListener('click', async () => {
  try {
    const d = await api('POST', '/api/platform/login', { token: $('#pf-token').value });
    state.token = d.token; state.platform = true;
    state.user = { name: '平台运维', role: 'PLATFORM' }; state.tenant = null;
    boot();
  } catch (e) { $('#login-err').textContent = e.message; }
});

$('#btn-logout').addEventListener('click', () => { state.token = null; $('#app').classList.add('hidden'); $('#login').classList.remove('hidden'); });

/* ------------------------------- 骨架 ------------------------------- */
const NAV = [
  { id: 'overview', name: '概览' },
  { id: 'employees', name: '员工授权' },
  { id: 'master', name: '基础数据' },
  { id: 'ai', name: 'AI 接口' },
  { id: 'schedule', name: '排产' },
  { id: 'orders', name: '订单' },
  { id: 'chat', name: '助手试跑' },
  { id: 'notifications', name: '消息' },
];
const NAV_PF = [{ id: 'tenants', name: '公司注册与授权' }, { id: 'stats', name: '平台统计' }];

function boot() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#who-name').textContent = `${state.user.name}（${state.user.role}）`;
  const navs = state.platform ? NAV_PF : NAV.filter((n) => state.user.role === 'ADMIN' || !['employees', 'ai'].includes(n.id));
  $('#nav').innerHTML = navs.map((n) => `<button data-v="${n.id}">${n.name}</button>`).join('');
  $$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.v)));
  go(navs[0].id);
}
function go(v) {
  state.view = v;
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.v === v));
  render();
}
async function render() {
  const m = $('#main');
  m.innerHTML = '<section><h2>加载中…</h2></section>';
  try {
    const fn = { overview, employees, master, ai, schedule, orders, chat, notifications, tenants, stats }[state.view];
    m.innerHTML = await fn();
    if (state.view === 'master') bindMaster();
    if (state.view === 'employees') bindEmployees();
    if (state.view === 'ai') bindAi();
    if (state.view === 'schedule') bindSchedule();
    if (state.view === 'orders') bindOrders();
    if (state.view === 'chat') bindChat();
    if (state.view === 'tenants') bindTenants();
  } catch (e) {
    m.innerHTML = `<section><h2>加载失败</h2><p class="err">${esc(e.message)}</p></section>`;
  }
}

/* ------------------------------- 概览 ------------------------------- */
async function overview() {
  const d = await api('GET', '/api/admin/overview');
  const t = d.tenant;
  const exp = t.expires_at ? new Date(String(t.expires_at).replace(' ', 'T')) : null;
  const days = exp ? Math.ceil((exp - Date.now()) / 86400000) : null;
  const ai = d.ai || {};
  const ob = d.onboarding || {};
  const stages = (ob.groups || []).map((g) => `
    <div class="stage">
      <h3>【${g.stage}】${esc(g.title)}</h3>
      <ul class="check">${g.items.map((i) => `
        <li>${i.done ? '✅' : (i.required ? '⬜' : '🟡')} ${esc(i.label)}：<span class="muted">${esc(i.detail)}</span>${i.required ? '' : '（选填）'}</li>`).join('')}</ul>
    </div>`).join('');

  return `
  <div class="grid">
    <div class="card"><div class="k">公司</div><div class="v" style="font-size:18px">${esc(t.name)}<small> ${esc(t.code)}</small></div></div>
    <div class="card"><div class="k">已用 / 授权用户数</div><div class="v">${t.used_users}<small> / ${t.max_users}</small></div></div>
    <div class="card"><div class="k">授权期限</div><div class="v" style="font-size:18px">${t.expires_at ? esc(String(t.expires_at).slice(0, 10)) : '不限期'}
      <small>${days === null ? '' : days < 0 ? '（已过期）' : `（剩 ${days} 天）`}</small></div></div>
    <div class="card"><div class="k">在建订单</div><div class="v">${d.open_orders}</div></div>
    <div class="card"><div class="k">AI 接口</div><div class="v" style="font-size:16px">
      <span class="tag ${ai.api_key_set ? 'ok' : 'warn'}">${ai.api_key_set ? '已配置 ' + esc(ai.api_key_mask || '') : '未配置（走兜底解析）'}</span></div>
      <div class="muted">${esc(ai.model || '')} @ ${esc(ai.base_url || '')}</div></div>
    <div class="card"><div class="k">基础数据完成度</div><div class="v">${ob.completeness ?? 0}<small>%</small></div>
      <div class="muted">${esc(ob.next_hint || '')}</div></div>
  </div>

  <section>
    <header><h2>主数据条数</h2></header>
    <div class="grid">
      ${Object.entries(d.master_counts).map(([k, v]) => `<div class="card"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join('')}
    </div>
  </section>

  <section>
    <header><h2>建档完成度</h2><span class="spacer"></span>
      <span class="tag ${ob.ready ? 'ok' : 'warn'}">${ob.ready ? '已齐全' : '待补齐'}</span></header>
    ${ob.caution ? `<p class="tag warn">${esc(ob.caution)}</p>` : ''}
    ${stages}
  </section>`;
}

/* ----------------------------- 员工授权 ----------------------------- */
async function employees() {
  const [list, master, roles] = await Promise.all([
    api('GET', '/api/admin/employees'), api('GET', '/api/master'), api('GET', '/api/admin/roles'),
  ]);
  state.master = master;
  const machines = master.machines || [];
  return `
  <section>
    <header><h2>员工授权</h2><span class="spacer"></span>
      <span class="muted">只有在此录入过的手机号，才能登录 APP</span></header>
    <div class="row">
      <label>手机号<input id="e-phone" placeholder="13800000008"></label>
      <label>姓名<input id="e-name" placeholder="张三"></label>
      <label>角色<select id="e-role">${roles.map((r) => `<option value="${r.role}">${esc(r.zh)}</option>`).join('')}</select></label>
      <label>绑定机台<select id="e-machine"><option value="">不绑定（接收全部机台消息）</option>
        ${machines.map((m) => `<option value="${esc(m.code)}">${esc(m.code)} ${esc(m.name || '')}</option>`).join('')}</select></label>
      <button id="e-add" class="primary" style="width:auto">授权</button>
    </div>
    <table><thead><tr><th>手机号</th><th>姓名</th><th>角色</th><th>绑定机台</th><th>状态</th><th>最近登录</th><th></th></tr></thead>
    <tbody>${list.map((u) => `<tr data-id="${u.id}">
      <td>${esc(u.phone)}</td><td>${esc(u.name)}</td><td>${esc(u.role_zh)}</td>
      <td>${esc(u.machine_code || '—')}</td>
      <td><span class="tag ${u.status === 'ACTIVE' ? 'ok' : 'err'}">${esc(u.status)}</span></td>
      <td class="muted">${esc(u.last_login_at ? String(u.last_login_at).slice(5, 16) : '未登录')}</td>
      <td>${u.role === 'ADMIN' ? '' : `<button class="danger" data-del="${u.id}">停用</button>`}</td>
    </tr>`).join('')}</tbody></table>
    <p class="hint">初始密码 123456，员工首次登录后可在 APP 内修改。</p>
  </section>`;
}
function bindEmployees() {
  $('#e-add').addEventListener('click', async () => {
    try {
      await api('POST', '/api/admin/employees', {
        phone: $('#e-phone').value.trim(), name: $('#e-name').value.trim(),
        role: $('#e-role').value, machineCode: $('#e-machine').value || null,
      });
      toast('已授权，该手机号现在可以登录 APP', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('DELETE', `/api/admin/employees/${b.dataset.del}`); toast('已停用', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

/* ----------------------------- 基础数据 ----------------------------- */
const FIELDS = {
  customers: [['code', '编码'], ['name', '名称'], ['aliases', '别名（逗号分隔）', 'csv'], ['contact', '联系人']],
  materials: [['sku', '料号'], ['name', '品名'], ['unit', '单位'], ['stock_qty', '现有库存', 'num'], ['safety_stock', '安全库存', 'num'], ['lead_time_days', '采购提前期(天)', 'num']],
  labels: [['sku', '标签编码'], ['name', '品名'], ['category', '品类'], ['unit', '单位'], ['stock_qty', '库存张数', 'num'], ['safety_stock', '安全库存', 'num'], ['lead_time_days', '补货天数', 'num']],
  molds: [['code', '模具编号'], ['name', '名称'], ['cavities', '穴数', 'num'], ['status', '状态', ['AVAILABLE', 'MAINTENANCE', 'RETIRED']], ['cumulative_shots', '累计模次', 'num'], ['maintenance_at_shots', '保养阈值模次', 'num']],
  mixers: [['code', '编号'], ['name', '名称'], ['capacity_kg', '容量kg', 'num'], ['status', '状态', ['AVAILABLE', 'FAULT', 'MAINTENANCE']]],
  supply_lines: [['code', '供料线编号'], ['name', '名称'], ['status', '状态', ['AVAILABLE', 'FAULT', 'MAINTENANCE']], ['recipe_key', '当前配方键'], ['mixer_code', '混料机'], ['machine_codes', '绑定机台（逗号分隔）', 'csv'], ['min_changeover_minutes', '换料提前量(分)', 'num']],
  machines: [['code', '机台编号'], ['name', '名称'], ['status', '状态', ['AVAILABLE', 'FAULT', 'MAINTENANCE']], ['current_mold_code', '机上模具'], ['mold_change_minutes', '换模时长(分)', 'num'], ['units_per_hour', '默认效率(件/时)', 'num'], ['feeding_mode', '供料方式', ['CENTRALIZED', 'HOPPER', 'MANUAL']], ['supply_line_code', '供料线编号'], ['mixer_code', '混料机'], ['product_skus', '可做产品（逗号分隔）', 'csv'], ['mold_codes', '可用模具（逗号分隔）', 'csv'], ['mold_efficiencies', '机台×模具效率 M-01:320,M-02:300', 'map']],
  products: [['sku', 'SKU'], ['name', '品名'], ['aliases', '别名/口语叫法（逗号分隔）', 'csv'], ['logo_version', '标志版本'], ['needs_label', '需贴标', 'bool'], ['labels_per_unit', '单件张数', 'num'], ['label_waste_rate', '标签损耗%', 'num'], ['label_skus', '绑定标签（逗号分隔）', 'csv'], ['loss_rate', '损耗率%', 'num'], ['unit', '单位'], ['recipe', '配方 PP-01:32,MB-01:0.5', 'recipe'], ['mold_codes', '可用模具（逗号分隔）', 'csv'], ['finished_stock_qty', '成品库存', 'num']],
};
const RES_NAMES = {
  machines: '机台', molds: '模具', materials: '原料', labels: '标签',
  supply_lines: '供料线', mixers: '混料机', products: '产品', customers: '客户',
};

async function master() {
  if (!state.master) state.master = await api('GET', '/api/master');
  const res = state._res || 'machines';
  const rows = state.master[res] || [];
  const fields = FIELDS[res] || [];
  const cols = fields.slice(0, 6).map((f) => f[0]);

  return `
  <section>
    <header><h2>基础数据</h2><span class="spacer"></span>
      <select id="m-res">${Object.entries(RES_NAMES).map(([k, v]) => `<option value="${k}" ${k === res ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <button id="m-reload">刷新</button></header>
    <table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}<th></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        ${cols.map((c) => `<td>${esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])}</td>`).join('')}
        <td><button data-edit="${i}">编辑</button> <button class="danger" data-rm="${r.id}">删除</button></td>
      </tr>`).join('') || '<tr><td colspan="9" class="muted">暂无数据</td></tr>'}</tbody></table>
  </section>

  <section>
    <header><h2>新增${esc(RES_NAMES[res])}</h2></header>
    <div class="row" id="m-form">
      ${fields.map(([k, label, type]) => {
        if (Array.isArray(type)) return `<label>${esc(label)}<select name="${k}">${type.map((o) => `<option>${o}</option>`).join('')}</select></label>`;
        if (type === 'bool') return `<label>${esc(label)}<select name="${k}"><option value="0">否</option><option value="1">是</option></select></label>`;
        return `<label>${esc(label)}<input name="${k}" ${type === 'num' ? 'type="number" step="any"' : ''}></label>`;
      }).join('')}
      <button id="m-add" class="primary" style="width:auto">新增</button>
    </div>
    <p class="hint">别名很重要：员工口语里叫「魔辣面筋」「麻辣面筋」，都要写进产品别名，AI 才能匹配上。</p>

    <h3 style="margin-top:18px">批量导入（JSON 数组）</h3>
    <textarea id="m-bulk" rows="6" placeholder='[{"code":"IM-04","name":"注塑机 4#"}]' style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;font:12px ui-monospace,Consolas,monospace"></textarea>
    <div class="row"><button id="m-bulk-go">导入</button><span class="muted">导入前会先清空该类目的现有数据</span></div>
  </section>`;
}
function bindMaster() {
  $('#m-res').addEventListener('change', () => { state._res = $('#m-res').value; render(); });
  $('#m-reload').addEventListener('click', async () => { state.master = await api('GET', '/api/master'); render(); });
  $('#m-add').addEventListener('click', async () => {
    const res = state._res || 'machines';
    const body = {};
    $$('#m-form [name]').forEach((el) => {
      const f = (FIELDS[res] || []).find((x) => x[0] === el.name);
      const t = f ? f[2] : null;
      let v = el.value;
      if (v === '') return;
      if (t === 'num') v = Number(v);
      else if (t === 'csv') v = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      else if (t === 'map') { v = {}; String(el.value).split(/[,，]/).filter(Boolean).forEach((p) => { const [a, b] = p.split(':'); v[a.trim()] = Number(b); }); }
      else if (t === 'recipe') v = String(el.value).split(/[,，]/).filter(Boolean).map((p) => { const [a, b] = p.split(':'); return { material_sku: a.trim(), grams_per_unit: Number(b) }; });
      else if (t === 'bool') v = Number(v);
      body[el.name] = v;
    });
    try { await api('POST', `/api/master/${res}`, body); toast('已新增', 'ok'); state.master = null; render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-rm]').forEach((b) => b.addEventListener('click', async () => {
    try { await api('DELETE', `/api/master/${state._res || 'machines'}/${b.dataset.rm}`); toast('已删除', 'ok'); state.master = null; render(); }
    catch (e) { toast(e.message, 'err'); }
  }));
  $('#m-bulk-go').addEventListener('click', async () => {
    const res = state._res || 'machines';
    try {
      const items = JSON.parse($('#m-bulk').value);
      await api('DELETE', `/api/master/${res}/clear`);
      const r = await api('POST', `/api/master/${res}/bulk`, { items });
      toast(`已导入 ${r.ids.length} 条`, 'ok'); state.master = null; render();
    } catch (e) { toast(e.message, 'err'); }
  });
}

/* ----------------------------- AI 配置 ------------------------------ */
async function ai() {
  const d = await api('GET', '/api/admin/ai-config');
  return `
  <section>
    <header><h2>AI 接口配置</h2><span class="spacer"></span>
      <span class="tag ${d.api_key_set ? 'ok' : 'warn'}">${d.api_key_set ? '已配置' : '未配置（走确定性兜底解析）'}</span></header>
    <div class="row">
      <label>服务地址 BaseURL<input id="ai-url" value="${esc(d.base_url)}"></label>
      <label>模型 Model<input id="ai-model" value="${esc(d.model)}"></label>
      <label>温度 Temperature<input id="ai-temp" type="number" step="0.1" value="${d.temperature}"></label>
      <label>超时(ms)<input id="ai-timeout" type="number" value="${d.timeout_ms}"></label>
    </div>
    <div class="row">
      <label>API Key<input id="ai-key" type="password" placeholder="${d.api_key_set ? '已保存，留空表示不修改' : 'sk-...'}"></label>
      <label>启用 AI<select id="ai-enabled"><option value="1" ${d.enabled ? 'selected' : ''}>启用</option><option value="0" ${!d.enabled ? 'selected' : ''}>停用</option></select></label>
      <label>失败时走兜底解析<select id="ai-fb"><option value="1" ${d.allow_fallback ? 'selected' : ''}>允许</option><option value="0" ${!d.allow_fallback ? 'selected' : ''}>不允许</option></select></label>
    </div>
    <div class="row"><button id="ai-save" class="primary" style="width:auto">保存</button>
      <button id="ai-test">测试连通性</button><span id="ai-msg" class="muted"></span></div>
    <p class="hint">支持任何 OpenAI 兼容协议的服务：DeepSeek、通义千问、智谱、本地 vLLM / Ollama 等。
      未配置 Key 时，系统使用内置确定性解析器（关键词 + 中文数量/日期解析 + 词典匹配），无需联网也能完成下单与出库。</p>
  </section>`;
}
function bindAi() {
  $('#ai-save').addEventListener('click', async () => {
    try {
      await api('PUT', '/api/admin/ai-config', {
        baseUrl: $('#ai-url').value, model: $('#ai-model').value,
        temperature: Number($('#ai-temp').value), timeoutMs: Number($('#ai-timeout').value),
        apiKey: $('#ai-key').value || undefined,
        enabled: $('#ai-enabled').value === '1', allowFallback: $('#ai-fb').value === '1',
      });
      toast('已保存', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $('#ai-test').addEventListener('click', async () => {
    $('#ai-msg').textContent = '测试中…';
    const r = await api('POST', '/api/admin/ai-config/test');
    $('#ai-msg').textContent = r.message;
    toast(r.ok ? '连通正常' : '连接失败', r.ok ? 'ok' : 'err');
  });
}

/* ------------------------------- 排产 ------------------------------- */
async function schedule() {
  const [tasks, mats, shift] = await Promise.all([
    api('GET', '/api/schedule/tasks'), api('GET', '/api/schedule/materials'),
    api('GET', '/api/schedule/shift?hours=12'),
  ]);
  return `
  <section>
    <header><h2>排产</h2><span class="spacer"></span><button id="s-run" class="primary" style="width:auto">运行排产</button>
      <button id="s-shift">推送交接班消息</button></header>
    <table><thead><tr><th>#</th><th>订单</th><th>产品</th><th>机台</th><th>模具</th><th>决策</th>
      <th class="num">数量</th><th>开工</th><th>完工</th><th>换料指令</th></tr></thead>
      <tbody>${tasks.map((t) => `<tr>
        <td>${t.seq}</td><td>${esc(t.order_code)}</td><td>${esc(t.product_name || '')}</td>
        <td>${esc(t.machine_code)}</td><td>${esc(t.mold_code)}</td>
        <td><span class="tag ${t.decision === 'CHANGE_MOLD' ? 'warn' : 'brand'}">${esc(t.decision)}</span></td>
        <td class="num">${t.planned_qty}</td>
        <td>${esc(String(t.start_at).slice(5, 16))}</td><td>${esc(String(t.end_at).slice(5, 16))}</td>
        <td class="muted">${esc(t.feeding_order_at ? String(t.feeding_order_at).slice(5, 16) : '—')}</td>
      </tr>`).join('') || '<tr><td colspan="10" class="muted">暂无排产任务</td></tr>'}</tbody></table>
  </section>

  <section><header><h2>配料计划（配料员视角）</h2></header>
    <table><thead><tr><th>类别</th><th>物料</th><th class="num">合计</th><th>单位</th><th>使用明细</th></tr></thead>
      <tbody>${(mats.items || []).map((i) => `<tr>
        <td><span class="tag ${i.kind === 'LABEL' ? 'warn' : ''}">${esc(i.kind)}</span></td>
        <td>${esc(i.name || i.sku)}（${esc(i.sku)}）</td><td class="num">${i.total_qty}</td><td>${esc(i.unit)}</td>
        <td class="muted">${(i.details || []).slice(0, 3).map((d) => `${esc(String(d.use_at).slice(5, 16))} ${d.qty}${esc(i.unit)}${d.mixer_code ? ' · ' + esc(d.mixer_code) : ''}`).join('｜')}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无</td></tr>'}</tbody></table>
  </section>

  <section><header><h2>当班计划（未来 12 小时）</h2></header>
    <table><thead><tr><th>机台</th><th>产品</th><th class="num">本班数量</th><th>模具</th><th>时间窗</th></tr></thead>
      <tbody>${(shift.items || []).map((i) => `<tr><td>${esc(i.machine_code)}</td><td>${esc(i.product_name || i.product_sku)}</td>
        <td class="num">${i.planned_qty}</td><td>${esc(i.mold_code)}</td>
        <td>${esc(String(i.window_start).slice(5, 16))}~${esc(String(i.window_end).slice(5, 16))}</td></tr>`).join('')
    || '<tr><td colspan="5" class="muted">本班无任务</td></tr>'}</tbody></table>
  </section>`;
}
function bindSchedule() {
  $('#s-run').addEventListener('click', async () => {
    try { const r = await api('POST', '/api/schedule/run', {}); toast(r.message || '排产完成', 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  });
  $('#s-shift').addEventListener('click', async () => {
    try { const r = await api('POST', '/api/schedule/shift-push', {}); toast(r.message, 'ok'); }
    catch (e) { toast(e.message, 'err'); }
  });
}

/* ------------------------------- 订单 ------------------------------- */
async function orders() {
  const [list, master] = await Promise.all([api('GET', '/api/orders'), api('GET', '/api/master')]);
  state.master = master;
  return `
  <section><header><h2>订单</h2></header>
    <div class="row">
      <label>产品<select id="o-product">${(master.products || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
      <label>客户<select id="o-customer"><option value="">—</option>${(master.customers || []).map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>数量<input id="o-qty" type="number" value="10000"></label>
      <label>交期<input id="o-due" type="date"></label>
      <button id="o-add" class="primary" style="width:auto">新建</button>
    </div>
    <table><thead><tr><th>单号</th><th>客户</th><th>产品</th><th class="num">数量</th><th class="num">待生产</th>
      <th class="num">已完工</th><th>交期</th><th>状态</th><th></th></tr></thead>
      <tbody>${list.map((o) => `<tr><td>${esc(o.code)}</td><td>${esc(o.customer_name || '—')}</td><td>${esc(o.product_name || '')}</td>
        <td class="num">${o.quantity}</td><td class="num">${o.remaining_qty}</td><td class="num">${o.completed_qty}</td>
        <td>${esc(o.due_date || '—')}</td><td><span class="tag ${o.status === 'COMPLETED' ? 'ok' : 'brand'}">${esc(o.status)}</span></td>
        <td><button data-ob="${o.id}">出库</button></td></tr>`).join('')
      || '<tr><td colspan="9" class="muted">暂无订单</td></tr>'}</tbody></table>
  </section>`;
}
function bindOrders() {
  $('#o-add').addEventListener('click', async () => {
    try {
      await api('POST', '/api/orders', {
        productId: Number($('#o-product').value), customerId: Number($('#o-customer').value) || null,
        quantity: Number($('#o-qty').value), dueDate: $('#o-due').value || null,
      });
      toast('已创建', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-ob]').forEach((b) => b.addEventListener('click', async () => {
    const q = prompt('出库数量');
    if (!q) return;
    try { const r = await api('POST', `/api/orders/${b.dataset.ob}/outbound`, { qty: Number(q) }); toast(r.message, 'ok'); render(); }
    catch (e) { toast(e.message, 'err'); }
  }));
}

/* ----------------------------- 助手试跑 ----------------------------- */
async function chat() {
  const logs = await api('GET', '/api/chat/logs').catch(() => []);
  return `
  <section><header><h2>自然语言助手 · 试跑</h2><span class="spacer"></span>
    <span class="muted">以当前登录身份执行，权限与 APP 一致</span></header>
    <div class="row"><label style="flex:3">说一句话
      <input id="c-text" placeholder="河北的魔辣面筋下2万个订单，13号交货"></label>
      <button id="c-send" class="primary" style="width:auto">执行</button>
      <button id="c-parse">仅解析</button></div>
    <div class="chat-box"><pre id="c-out" style="margin:0;white-space:pre-wrap">（结果将显示在这里）</pre></div>
  </section>
  <section><header><h2>最近解析留痕</h2></header>
    <table><thead><tr><th>时间</th><th>原话</th><th>意图</th><th>方式</th><th>置信度</th><th>结果</th></tr></thead>
      <tbody>${logs.map((l) => `<tr><td class="muted">${esc(String(l.created_at).slice(5, 16))}</td><td>${esc(l.raw_text)}</td>
        <td>${esc(l.intent)}</td><td>${l.used_fallback ? '兜底' : 'AI'}</td><td>${l.confidence}</td><td>${esc(l.result || '')}</td></tr>`).join('')
      || '<tr><td colspan="6" class="muted">暂无</td></tr>'}</tbody></table>
  </section>`;
}
function bindChat() {
  $('#c-send').addEventListener('click', async () => {
    $('#c-out').textContent = '执行中…';
    try {
      const r = await api('POST', '/api/chat', { text: $('#c-text').value });
      $('#c-out').textContent = `意图：${r.intent}（置信度 ${r.confidence}，${r.used_fallback ? '确定性兜底' : 'AI'}）\n\n${r.message}`;
      render();
    } catch (e) { $('#c-out').textContent = `失败：${e.message}`; }
  });
  $('#c-parse').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/chat/parse', { text: $('#c-text').value });
      $('#c-out').textContent = JSON.stringify(r, null, 2);
    } catch (e) { $('#c-out').textContent = `失败：${e.message}`; }
  });
}

/* ------------------------------- 消息 ------------------------------- */
async function notifications() {
  const list = await api('GET', '/api/notifications?limit=60');
  return `<section><header><h2>消息中心</h2><span class="spacer"></span>
    <button id="n-read">全部标记已读</button></header>
    <table><thead><tr><th>时间</th><th>类型</th><th>标题</th><th>内容</th><th>机台</th></tr></thead>
    <tbody>${list.map((n) => `<tr><td class="muted">${esc(String(n.created_at).slice(5, 16))}</td>
      <td><span class="tag ${n.level === 'ERROR' ? 'err' : n.level === 'WARN' ? 'warn' : ''}">${esc(n.type)}</span></td>
      <td>${esc(n.title)}</td><td style="white-space:pre-wrap">${esc(n.body || '')}</td>
      <td>${esc(n.machine_code || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">暂无消息</td></tr>'}</tbody></table>
  </section>`;
}

/* ---------------------------- 平台：公司 ---------------------------- */
async function tenants() {
  const list = await api('GET', '/api/platform/tenants');
  return `
  <section><header><h2>注册公司</h2></header>
    <div class="row">
      <label>公司编码<input id="t-code" placeholder="DEMO"></label>
      <label>公司名称<input id="t-name" placeholder="某某注塑厂"></label>
      <label>管理员姓名<input id="t-admin" placeholder="张厂长"></label>
      <label>管理员手机号<input id="t-phone" placeholder="13800000001"></label>
      <label>初始密码<input id="t-pwd" value="123456"></label>
      <label>授权用户数<input id="t-max" type="number" value="20"></label>
      <label>授权到期日<input id="t-exp" type="date"></label>
      <button id="t-add" class="primary" style="width:auto">注册</button>
    </div>
  </section>
  <section><header><h2>公司列表与授权</h2></header>
    <table><thead><tr><th>ID</th><th>编码</th><th>名称</th><th class="num">已用/上限</th><th>到期日</th><th>状态</th><th>调整授权</th></tr></thead>
    <tbody>${list.map((t) => `<tr><td>${t.id}</td><td>${esc(t.code)}</td><td>${esc(t.name)}</td>
      <td class="num">${t.used_users} / ${t.max_users}</td><td>${esc(t.expires_at ? String(t.expires_at).slice(0, 10) : '不限期')}</td>
      <td><span class="tag ${t.status === 'ACTIVE' ? 'ok' : 'err'}">${esc(t.status)}</span></td>
      <td><button data-tb="${t.id}" data-max="${t.max_users}" data-exp="${t.expires_at ? String(t.expires_at).slice(0, 10) : ''}">修改</button></td>
    </tr>`).join('') || '<tr><td colspan="7" class="muted">尚无公司</td></tr>'}</tbody></table>
  </section>`;
}
function bindTenants() {
  $('#t-add').addEventListener('click', async () => {
    try {
      await api('POST', '/api/platform/tenants', {
        code: $('#t-code').value.trim(), name: $('#t-name').value.trim(),
        adminName: $('#t-admin').value.trim(), adminPhone: $('#t-phone').value.trim(),
        adminPassword: $('#t-pwd').value, maxUsers: Number($('#t-max').value),
        expiresAt: $('#t-exp').value || null,
      });
      toast('公司已注册', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  });
  $$('[data-tb]').forEach((b) => b.addEventListener('click', async () => {
    const max = prompt('授权用户数', b.dataset.max);
    if (max === null) return;
    const exp = prompt('授权到期日（YYYY-MM-DD，留空为不限期）', b.dataset.exp);
    try {
      await api('PUT', `/api/platform/tenants/${b.dataset.tb}/license`, { maxUsers: Number(max), expiresAt: exp || null });
      toast('授权已更新', 'ok'); render();
    } catch (e) { toast(e.message, 'err'); }
  }));
}

async function stats() {
  const d = await api('GET', '/api/platform/stats');
  return `<section><header><h2>平台统计</h2></header>
    <div class="grid">
      <div class="card"><div class="k">公司数</div><div class="v">${d.tenants}</div></div>
      <div class="card"><div class="k">员工数</div><div class="v">${d.employees}</div></div>
      <div class="card"><div class="k">订单数</div><div class="v">${d.orders}</div></div>
    </div>
    <h3>30 天内到期</h3>
    <table><thead><tr><th>编码</th><th>名称</th><th>到期日</th></tr></thead>
    <tbody>${(d.expiring_soon || []).map((t) => `<tr><td>${esc(t.code)}</td><td>${esc(t.name)}</td><td>${esc(String(t.expires_at).slice(0, 10))}</td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">无</td></tr>'}</tbody></table>
  </section>`;
}
