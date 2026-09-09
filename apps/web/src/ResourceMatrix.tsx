import { useState } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';
async function save(path: string, body: unknown) {
  const r = await fetch(`${API}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error((await r.json().catch(() => null))?.message || '保存失败');
}

export default function ResourceMatrix({ molds, machines, onChanged, notify }: { molds: any[]; machines: any[]; onChanged: () => void; notify: (s: string) => void }) {
  const [moldCode, setMoldCode] = useState(molds[0]?.code || '');
  const [machineCode, setMachineCode] = useState(machines[0]?.code || '');
  const [moldRates, setMoldRates] = useState<Record<string, string>>({});
  const [machineRates, setMachineRates] = useState<Record<string, string>>({});
  const mold = molds.find(x => x.code === moldCode); const machine = machines.find(x => x.code === machineCode);
  const submitMold = async (e: React.FormEvent) => { e.preventDefault(); if (!mold) return; try { const mappings = Object.entries(moldRates).filter(([, v]) => Number(v) > 0).map(([machineCode, unitsPerHour]) => ({ machineCode, unitsPerHour: Number(unitsPerHour) })); await save(`/molds/${mold.code}`, { machineEfficiencies: mappings }); notify('模具-设备效率已保存'); onChanged(); } catch (e: any) { notify(e.message); } };
  const submitMachine = async (e: React.FormEvent) => { e.preventDefault(); if (!machine) return; try { const mappings = Object.entries(machineRates).filter(([, v]) => Number(v) > 0).map(([moldCode, unitsPerHour]) => ({ moldCode, unitsPerHour: Number(unitsPerHour) })); await save(`/machines/${machine.code}`, { moldEfficiencies: mappings, moldCodes: mappings.map(x => x.moldCode) }); notify('设备-模具效率已保存'); onChanged(); } catch (e: any) { notify(e.message); } };
  return <section className="card matrix-card"><h2>设备 / 模具效率矩阵</h2><p className="muted">同一套模具可安装在多台设备上；同一台设备使用不同模具时可分别维护效率。空白或 0 表示不允许组合。</p><div className="matrix-grid"><form onSubmit={submitMold}><h3>从模具配置设备能力</h3><label>选择模具<select value={moldCode} onChange={e => setMoldCode(e.target.value)}>{molds.map(x => <option key={x.code} value={x.code}>{x.code} · {x.name}</option>)}</select></label>{machines.map(x => <label key={x.code}><input type="checkbox" checked={moldRates[x.code] !== undefined} onChange={e => setMoldRates(v => { const n = { ...v }; if (e.target.checked) n[x.code] = String(x.unitsPerHour || ''); else delete n[x.code]; return n; })} /> {x.code} {x.name}<input type="number" min="0" placeholder="件/小时" value={moldRates[x.code] || ''} onChange={e => setMoldRates(v => ({ ...v, [x.code]: e.target.value }))} /></label>)}<button className="primary">保存模具效率</button></form><form onSubmit={submitMachine}><h3>从设备配置模具能力</h3><label>选择设备<select value={machineCode} onChange={e => setMachineCode(e.target.value)}>{machines.map(x => <option key={x.code} value={x.code}>{x.code} · {x.name}</option>)}</select></label>{molds.map(x => <label key={x.code}><input type="checkbox" checked={machineRates[x.code] !== undefined} onChange={e => setMachineRates(v => { const n = { ...v }; if (e.target.checked) n[x.code] = String(machine?.unitsPerHour || ''); else delete n[x.code]; return n; })} /> {x.code} {x.name}<input type="number" min="0" placeholder="件/小时" value={machineRates[x.code] || ''} onChange={e => setMachineRates(v => ({ ...v, [x.code]: e.target.value }))} /></label>)}<button className="primary">保存设备效率</button></form></div></section>;
}
