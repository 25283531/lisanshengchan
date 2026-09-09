import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InventoryTransaction, Machine, Material, Mold, Product, ResourceFault, SupplyLine, WorkOrder } from './entities.js';

type OrderType = 'SALES' | 'STOCK';
type CreateOrder = { productSku: string; quantity: number; dueDate?: string | null; orderType?: OrderType; priorityScore?: number };
type Candidate = { machine: Machine; line: SupplyLine; moldCode: string; currentMoldCode: string | null; requiresMoldChange: boolean; setupMinutes: number; availableAt: Date; start: Date; end: Date; estimatedHours: number; deadline?: Date; latenessMinutes: number; slackMinutes: number | null; addMaterialAt: Date; changeMaterialAt: Date; reason: string };

@Injectable()
export class ProductionService {
  constructor(
    @InjectRepository(Product) private products: Repository<Product>, @InjectRepository(Material) private materials: Repository<Material>,
    @InjectRepository(Machine) private machines: Repository<Machine>, @InjectRepository(Mold) private molds: Repository<Mold>,
    @InjectRepository(SupplyLine) private lines: Repository<SupplyLine>, @InjectRepository(WorkOrder) private orders: Repository<WorkOrder>,
    @InjectRepository(ResourceFault) private faults: Repository<ResourceFault>, @InjectRepository(InventoryTransaction) private transactions: Repository<InventoryTransaction>,
  ) {}
  async dashboard() { return { products: await this.products.count(), materials: await this.materials.count(), machines: await this.machines.find(), openFaults: await this.faults.count({ where: { status: 'OPEN' } }), orders: await this.orders.find({ order: { createdAt: 'DESC' }, take: 10 }) }; }
  async updateProduct(sku: string, data: Partial<Product>) { const item = await this.products.findOneBy({ sku }); if (!item) throw new NotFoundException('产品不存在'); Object.assign(item, data); return this.products.save(item); }
  async deleteProduct(sku: string) { if (await this.orders.count({ where: { productSku: sku } })) throw new BadRequestException('该产品已有工单，不能删除'); const item = await this.products.findOneBy({ sku }); if (!item) throw new NotFoundException('产品不存在'); await this.products.remove(item); return { deleted: sku }; }
  async createProduct(data: Partial<Product>) { if (!data.sku || !data.name || !data.recipe?.length) throw new BadRequestException('产品编码、名称和原料配方为必填项'); return this.products.save(this.products.create(data)); }
  async listProducts() { return this.products.find({ order: { sku: 'ASC' } }); }
  async updateMaterial(sku: string, data: Partial<Material>) { const item = await this.materials.findOneBy({ sku }); if (!item) throw new NotFoundException('原料不存在'); Object.assign(item, data); return this.materials.save(item); }
  async deleteMaterial(sku: string) { const products = await this.products.find(); if (products.some(p => p.recipe.some(r => r.materialSku === sku))) throw new BadRequestException('该原料正在被产品配方引用，不能删除'); const item = await this.materials.findOneBy({ sku }); if (!item) throw new NotFoundException('原料不存在'); await this.materials.remove(item); return { deleted: sku }; }
  async createMaterial(data: Partial<Material>) { if (!data.sku || !data.name) throw new BadRequestException('原料编码和名称为必填项'); return this.materials.save(this.materials.create(data)); }
  async listMaterials() { return this.materials.find({ order: { sku: 'ASC' } }); }
  async adjustInventory(sku: string, quantityKg: number, type: InventoryTransaction['type'], note?: string) { const m = await this.materials.findOneBy({ sku }); if (!m) throw new NotFoundException('原料不存在'); const next = Number(m.stockKg) + quantityKg; if (next < 0) throw new BadRequestException('库存不足'); m.stockKg = next; await this.materials.save(m); return this.transactions.save(this.transactions.create({ materialSku: sku, quantityKg, type, note: note ?? null, referenceCode: null })); }
  async createMold(data: Partial<Mold>) { if (!data.code || !data.name || !data.cavities) throw new BadRequestException('模具编号、名称和穴数为必填项'); const mappings = (data.machineEfficiencies ?? []).filter(x => x?.machineCode && Number(x.unitsPerHour) > 0).map(x => ({ machineCode: x.machineCode, unitsPerHour: Number(x.unitsPerHour) })); return this.molds.save(this.molds.create({ ...data, machineEfficiencies: mappings })); }
  async listMolds() { return this.molds.find({ order: { code: 'ASC' } }); }
  async updateMold(code: string, data: Partial<Mold>) { const item = await this.molds.findOneBy({ code }); if (!item) throw new NotFoundException('模具不存在'); Object.assign(item, data); return this.molds.save(item); }
  async deleteMold(code: string) { const machines = await this.machines.find(); if (machines.some(m => m.moldCodes.includes(code))) throw new BadRequestException('该模具仍关联设备，不能删除'); const item = await this.molds.findOneBy({ code }); if (!item) throw new NotFoundException('模具不存在'); await this.molds.remove(item); return { deleted: code }; }
  async createMachine(data: Partial<Machine>) { if (!data.code || !data.name || !data.unitsPerHour) throw new BadRequestException('设备编号、名称和效率为必填项'); const mappings = (data.moldEfficiencies ?? []).filter(x => x?.moldCode && Number(x.unitsPerHour) > 0).map(x => ({ moldCode: x.moldCode, unitsPerHour: Number(x.unitsPerHour) })); const moldCodes = Array.from(new Set([...(data.moldCodes ?? []), ...mappings.map(x => x.moldCode)])); return this.machines.save(this.machines.create({ ...data, moldCodes, moldEfficiencies: mappings })); }
  async listMachines() { return this.machines.find({ order: { code: 'ASC' } }); }
  async updateMachine(code: string, data: Partial<Machine>) { const item = await this.machines.findOneBy({ code }); if (!item) throw new NotFoundException('设备不存在'); Object.assign(item, data); return this.machines.save(item); }
  async deleteMachine(code: string) { if (await this.orders.count({ where: { machineCode: code } })) throw new BadRequestException('该设备仍关联工单，不能删除'); const item = await this.machines.findOneBy({ code }); if (!item) throw new NotFoundException('设备不存在'); await this.machines.remove(item); return { deleted: code }; }
  async createSupplyLine(data: Partial<SupplyLine>) { if (!data.code || !data.name || !data.recipeKey) throw new BadRequestException('供料线基础信息不完整'); return this.lines.save(this.lines.create(data)); }
  async listSupplyLines() { return this.lines.find({ order: { code: 'ASC' } }); }
  async updateSupplyLine(code: string, data: Partial<SupplyLine>) { const item = await this.lines.findOneBy({ code }); if (!item) throw new NotFoundException('供料线不存在'); Object.assign(item, data); return this.lines.save(item); }
  async deleteSupplyLine(code: string) { if (await this.orders.count({ where: { supplyLineCode: code } })) throw new BadRequestException('该供料线仍关联工单，不能删除'); const item = await this.lines.findOneBy({ code }); if (!item) throw new NotFoundException('供料线不存在'); await this.lines.remove(item); return { deleted: code }; }

  private deadline(date?: string | null) { return date ? new Date(`${date}T23:59:59.999`) : undefined; }
  private summary(candidate: Candidate) { return { machineCode: candidate.machine.code, supplyLineCode: candidate.line.code, moldCode: candidate.moldCode, currentMoldCode: candidate.currentMoldCode, requiresMoldChange: candidate.requiresMoldChange, setupMinutes: candidate.setupMinutes, availableAt: candidate.availableAt, scheduledStart: candidate.start, scheduledEnd: candidate.end, addMaterialAt: candidate.addMaterialAt, changeMaterialAt: candidate.changeMaterialAt, estimatedHours: Number(candidate.estimatedHours.toFixed(2)), latenessMinutes: candidate.latenessMinutes, slackHours: candidate.slackMinutes === null ? null : Number((candidate.slackMinutes / 60).toFixed(2)), reason: candidate.reason }; }
  async recommend(data: CreateOrder) {
    if (!data.quantity || data.quantity <= 0) throw new BadRequestException('计划数量必须大于 0');
    const product = await this.products.findOneBy({ sku: data.productSku }); if (!product) throw new NotFoundException('产品不存在');
    const orderType = data.orderType ?? 'SALES'; if (orderType === 'SALES' && !data.dueDate) throw new BadRequestException('销售订单必须提供订单交期');
    const materials = await this.materials.find();
    const requirements = product.recipe.map(i => { const kg = data.quantity * Number(i.gramsPerUnit) / 1000 * (1 + Number(product.lossRate) / 100); const material = materials.find(m => m.sku === i.materialSku); return { materialSku: i.materialSku, requiredKg: Number(kg.toFixed(3)), availableKg: Number(material?.stockKg ?? 0), sufficient: !!material && Number(material.stockKg) >= kg }; });
    const now = new Date(); const deadline = this.deadline(data.dueDate); const lines = await this.lines.find(); const machines = (await this.machines.find()).filter(m => m.status === 'AVAILABLE' && m.productSkus.includes(product.sku)); const scheduled = await this.orders.find({ where: { status: 'SCHEDULED' } });
    const moldRecords = (await this.molds.find()).filter(m => m.status === 'AVAILABLE');
    const activeMolds = new Set(moldRecords.map(m => m.code));
    const productMolds = product.moldCodes?.length ? product.moldCodes.filter(code => activeMolds.has(code)) : [];
    const candidates: Candidate[] = [];
    for (const machine of machines) {
      const compatibleMolds = machine.moldCodes.filter(code => activeMolds.has(code) && (productMolds.length === 0 || productMolds.includes(code)));
      for (const moldCode of compatibleMolds) {
        const line = lines.filter(l => l.status === 'AVAILABLE' && l.machineCodes.includes(machine.code)).sort((a,b) => Number(new Date(a.occupiedUntil ?? 0)) - Number(new Date(b.occupiedUntil ?? 0)))[0]; if (!line) continue;
        const previous = scheduled.filter(o => o.machineCode === machine.code && o.scheduledEnd && new Date(o.scheduledEnd) > now).sort((a,b) => new Date(b.scheduledEnd!).getTime() - new Date(a.scheduledEnd!).getTime())[0];
        const currentMoldCode = previous?.assignedMoldCode ?? machine.currentMoldCode ?? null;
        const machineAvailableAt = previous?.scheduledEnd && new Date(previous.scheduledEnd) > now ? new Date(previous.scheduledEnd) : now;
        const lineAvailableAt = line.occupiedUntil && new Date(line.occupiedUntil) > now ? new Date(line.occupiedUntil) : now;
        const availableAt = new Date(Math.max(machineAvailableAt.getTime(), lineAvailableAt.getTime()));
        const requiresMoldChange = !!currentMoldCode && currentMoldCode !== moldCode;
        const setupMinutes = requiresMoldChange ? machine.moldChangeMinutes : 0;
        const start = new Date(availableAt.getTime() + setupMinutes * 60000 + 30 * 60000);
        const mold = moldRecords.find(m => m.code === moldCode);
        const machineRate = machine.moldEfficiencies?.find(x => x.moldCode === moldCode)?.unitsPerHour;
        const moldRate = mold?.machineEfficiencies?.find(x => x.machineCode === machine.code)?.unitsPerHour;
        const effectiveUnitsPerHour = Number(machineRate ?? moldRate ?? machine.unitsPerHour);
        const estimatedHours = data.quantity / effectiveUnitsPerHour; const end = new Date(start.getTime() + estimatedHours * 3600000);
        const addMaterialAt = new Date(Math.max(now.getTime(), start.getTime() - 30 * 60000));
        const changeMaterialAt = new Date(Math.max(now.getTime(), start.getTime() - line.minChangeoverMinutes * 60000));
        const latenessMinutes = deadline ? Math.max(0, Math.ceil((end.getTime() - deadline.getTime()) / 60000)) : 0;
        const slackMinutes = deadline ? Math.floor((deadline.getTime() - end.getTime()) / 60000) : null;
        const reason = !requiresMoldChange ? `保留 ${moldCode}，无需换模` : currentMoldCode ? `由 ${currentMoldCode} 更换为 ${moldCode}` : `启用空闲设备并安装 ${moldCode}`;
        candidates.push({ machine, line, moldCode, currentMoldCode, requiresMoldChange, setupMinutes, availableAt, start, end, estimatedHours, deadline, latenessMinutes, slackMinutes, addMaterialAt, changeMaterialAt, reason: `${reason}；效率 ${effectiveUnitsPerHour} 件/小时` });
      }
    }
    if (!candidates.length) return { feasible: false, reason: '没有具备产品、模具与供料条件的可用资源', requirements, candidates: [] };
    candidates.sort((a,b) => {
      if (orderType === 'STOCK') return Number(a.requiresMoldChange) - Number(b.requiresMoldChange) || a.setupMinutes - b.setupMinutes || a.end.getTime() - b.end.getTime();
      // Priority is persisted on the work order for global queue sequencing;
      // resource choice first protects the due date, then avoids changeovers.
      return a.latenessMinutes - b.latenessMinutes || Number(a.requiresMoldChange) - Number(b.requiresMoldChange) || a.end.getTime() - b.end.getTime();
    });
    const chosen = candidates[0]; const urgency = !deadline ? '库存订单：优先减少换模和占用' : chosen.latenessMinutes > 0 ? '交期风险：建议采用最早完工方案' : chosen.slackMinutes! <= 24 * 60 ? '紧急：交期余量不足 1 天' : chosen.slackMinutes! <= 3 * 24 * 60 ? '较紧急：交期余量不足 3 天' : '交期可控';
    const decision = !chosen.requiresMoldChange ? 'KEEP_CURRENT_MOLD' : chosen.currentMoldCode === null ? 'ACTIVATE_IDLE_MACHINE' : 'CHANGE_MOLD';
    return { feasible: requirements.every(r => r.sufficient), product: product.sku, orderType, dueDate: data.dueDate ?? null, urgency, decision, requirements, ...this.summary(chosen), candidates: candidates.map(c => this.summary(c)) };
  }
  async listOrders() { return this.orders.find({ order: { scheduledStart: 'ASC' } }); }
  async batchRecommend(data: { orders: CreateOrder[] }) {
    if (!data.orders?.length) throw new BadRequestException('至少提供一张订单');
    const sorted = [...data.orders].sort((a, b) => {
      const ad = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      const bd = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER;
      return ad - bd || Number(b.priorityScore ?? 0) - Number(a.priorityScore ?? 0);
    });
    const plans = [];
    for (const order of sorted) plans.push({ input: order, plan: await this.recommend(order) });
    return { count: plans.length, feasible: plans.every(x => x.plan.feasible), plans };
  }
  async updateSchedule(id: string, data: { machineCode: string; supplyLineCode: string; moldCode?: string; scheduledStart: string; scheduledEnd: string }) {
    const order = await this.orders.findOneBy({ id }); if (!order) throw new NotFoundException('工单不存在');
    const machine = await this.machines.findOneBy({ code: data.machineCode }); const line = await this.lines.findOneBy({ code: data.supplyLineCode });
    if (!machine || machine.status !== 'AVAILABLE') throw new BadRequestException('目标设备不可用');
    if (!line || line.status !== 'AVAILABLE' || !line.machineCodes.includes(machine.code)) throw new BadRequestException('目标供料线不可用或未关联设备');
    const start = new Date(data.scheduledStart), end = new Date(data.scheduledEnd); if (!(end > start)) throw new BadRequestException('完工时间必须晚于开工时间');
    const overlap = await this.orders.createQueryBuilder('o').where('o.id <> :id', { id }).andWhere('o.machineCode = :machine', { machine: machine.code }).andWhere('o.status IN (:...statuses)', { statuses: ['SCHEDULED', 'RUNNING'] }).andWhere('o.scheduledStart < :end AND o.scheduledEnd > :start', { start, end }).getCount();
    if (overlap) throw new BadRequestException('目标设备在该时间段已有工单');
    Object.assign(order, { machineCode: machine.code, supplyLineCode: line.code, assignedMoldCode: data.moldCode ?? order.assignedMoldCode, scheduledStart: start, scheduledEnd: end });
    await this.lines.update({ code: line.code }, { occupiedUntil: end }); return this.orders.save(order);
  }
  async splitOrder(id: string, quantity: number) {
    const order = await this.orders.findOneBy({ id }); if (!order) throw new NotFoundException('工单不存在');
    if (!Number.isInteger(quantity) || quantity <= 0 || quantity >= order.quantity) throw new BadRequestException('拆分数量必须小于原工单数量');
    const siblings = await this.orders.count({ where: [{ code: order.code }, { parentOrderCode: order.code }] });
    order.quantity -= quantity; const saved = await this.orders.save(order);
    const child = this.orders.create({ ...order, id: undefined, code: `WO-${Date.now().toString().slice(-8)}`, quantity, parentOrderCode: order.parentOrderCode ?? order.code, splitSequence: siblings + 1, status: 'DRAFT', machineCode: null, supplyLineCode: null, assignedMoldCode: null, scheduledStart: null, scheduledEnd: null });
    return { original: saved, child: await this.orders.save(child) };
  }
  async listFaults() { return this.faults.find({ order: { createdAt: 'DESC' } }); }
  async createOrder(data: CreateOrder) { const plan: any = await this.recommend(data); if (!plan.feasible || !plan.machineCode || !plan.supplyLineCode || !plan.scheduledStart || !plan.scheduledEnd || !plan.moldCode) throw new BadRequestException({ message: '无法创建可行排产方案', plan }); const order = await this.orders.save(this.orders.create({ code: `WO-${Date.now().toString().slice(-8)}`, productSku: data.productSku, quantity: data.quantity, dueDate: data.dueDate ?? null, orderType: data.orderType ?? 'SALES', priorityScore: data.priorityScore ?? 0, status: 'SCHEDULED', machineCode: plan.machineCode, supplyLineCode: plan.supplyLineCode, assignedMoldCode: plan.moldCode, scheduledStart: plan.scheduledStart, scheduledEnd: plan.scheduledEnd })); for (const r of plan.requirements) await this.adjustInventory(r.materialSku, -r.requiredKg, 'PRODUCTION_RESERVE', `预占用：${order.code}`); await this.lines.update({ code: plan.supplyLineCode }, { occupiedUntil: plan.scheduledEnd }); return { order, plan }; }
  async createFault(data: { resourceType: 'MACHINE' | 'SUPPLY_LINE'; resourceCode: string; note: string; estimatedHours: number }) { if (!data.estimatedHours || data.estimatedHours <= 0) throw new BadRequestException('预计维修时长必须大于 0'); const blockedUntil = new Date(Date.now() + data.estimatedHours * 3600000); if (data.resourceType === 'MACHINE') { const machine = await this.machines.findOneBy({ code: data.resourceCode }); if (!machine) throw new NotFoundException('设备不存在'); machine.status = 'FAULT'; await this.machines.save(machine); } else { const line = await this.lines.findOneBy({ code: data.resourceCode }); if (!line) throw new NotFoundException('供料线不存在'); line.status = 'FAULT'; await this.lines.save(line); for (const code of line.machineCodes) { const machine = await this.machines.findOneBy({ code }); if (machine) { machine.status = 'FAULT'; await this.machines.save(machine); } } } return this.faults.save(this.faults.create({ ...data, blockedUntil, status: 'OPEN' })); }
  async resolveFault(id: string) { const fault = await this.faults.findOneBy({ id }); if (!fault) throw new NotFoundException('故障记录不存在'); fault.status = 'RESOLVED'; const saved = await this.faults.save(fault); if (fault.resourceType === 'MACHINE') { const machine = await this.machines.findOneBy({ code: fault.resourceCode }); if (machine) { machine.status = 'AVAILABLE'; await this.machines.save(machine); } } else { const line = await this.lines.findOneBy({ code: fault.resourceCode }); if (line) { line.status = 'AVAILABLE'; await this.lines.save(line); for (const code of line.machineCodes) { const machine = await this.machines.findOneBy({ code }); if (machine && machine.status === 'FAULT') { machine.status = 'AVAILABLE'; await this.machines.save(machine); } } } } return saved; }
}
