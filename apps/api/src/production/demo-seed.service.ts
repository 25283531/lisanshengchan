import { Injectable, OnModuleInit } from '@nestjs/common';
import { ProductionService } from './production.service.js';
@Injectable()
export class DemoSeedService implements OnModuleInit {
  constructor(private readonly production: ProductionService) {}
  async onModuleInit() {
    if (process.env.SEED_DEMO_DATA !== 'true') return;
    const existing = await this.production.listProducts();
    if (existing.length) return;
    await this.production.createMaterial({ sku: 'RM-PP-T30', name: 'PP-T30 透明注塑料', stockKg: 4820, safetyStockKg: 1500 });
    await this.production.createMaterial({ sku: 'MB-BL-03', name: '食品级蓝色母', stockKg: 145, safetyStockKg: 50 });
    await this.production.createMaterial({ sku: 'RM-PP-HM30', name: 'PP-HM30 耐热料', stockKg: 2060, safetyStockKg: 800 });
    await this.production.createMold({ code: 'M-750-02', name: '750ml 餐盒模具', cavities: 4, status: 'AVAILABLE', machineEfficiencies: [{ machineCode: 'IM-03', unitsPerHour: 1250 }] });
    await this.production.createMold({ code: 'M-900-01', name: '900ml 分格盒模具', cavities: 2, status: 'AVAILABLE', machineEfficiencies: [{ machineCode: 'IM-08', unitsPerHour: 1100 }] });
    await this.production.createProduct({ sku: 'P750', name: '方形餐盒 750ml', logoVersion: 'V3 蓝标', lossRate: 1.5, moldCodes: ['M-750-02'], recipe: [{ materialSku: 'RM-PP-T30', gramsPerUnit: 18.6 }, { materialSku: 'MB-BL-03', gramsPerUnit: 0.37 }] });
    await this.production.createProduct({ sku: 'P900', name: '分格便当盒 900ml', logoVersion: 'V2 黑标', lossRate: 1.8, moldCodes: ['M-900-01'], recipe: [{ materialSku: 'RM-PP-HM30', gramsPerUnit: 29.4 }] });
    await this.production.createMachine({ code: 'IM-03', name: '海天 MA2800', moldCodes: ['M-750-02'], moldEfficiencies: [{ moldCode: 'M-750-02', unitsPerHour: 1250 }], currentMoldCode: 'M-750-02', productSkus: ['P750'], unitsPerHour: 1250, status: 'AVAILABLE' });
    await this.production.createMachine({ code: 'IM-08', name: '震雄 SM350', moldCodes: ['M-900-01'], moldEfficiencies: [{ moldCode: 'M-900-01', unitsPerHour: 1100 }], currentMoldCode: 'M-900-01', productSkus: ['P900'], unitsPerHour: 1100, status: 'AVAILABLE' });
    await this.production.createSupplyLine({ code: 'S-01', name: '透明 PP 主线', machineCodes: ['IM-03'], recipeKey: 'PP-T30 + MB-BL-03', minChangeoverMinutes: 60, status: 'AVAILABLE' });
    await this.production.createSupplyLine({ code: 'S-03', name: '高温 PP 线', machineCodes: ['IM-08'], recipeKey: 'PP-HM30', minChangeoverMinutes: 120, status: 'AVAILABLE' });
  }
}
