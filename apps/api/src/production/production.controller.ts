import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ProductionService } from './production.service.js';
@ApiTags('production')
@Controller()
export class ProductionController {
  constructor(private readonly service: ProductionService) {}
  @Get('dashboard') dashboard() { return this.service.dashboard(); }
  @Get('products') products() { return this.service.listProducts(); }
  @Post('products') createProduct(@Body() data: any) { return this.service.createProduct(data); }
    @Patch('products/:sku') updateProduct(@Param('sku') sku: string, @Body() data: any) { return this.service.updateProduct(sku, data); }
  @Delete('products/:sku') deleteProduct(@Param('sku') sku: string) { return this.service.deleteProduct(sku); }  @Get('materials') materials() { return this.service.listMaterials(); }
  @Post('materials') createMaterial(@Body() data: any) { return this.service.createMaterial(data); }
  @Patch('materials/:sku/inventory') adjust(@Param('sku') sku: string, @Body() body: { quantityKg: number; type: 'RECEIPT' | 'MANUAL_USE' | 'ADJUSTMENT'; note?: string }) { return this.service.adjustInventory(sku, body.quantityKg, body.type, body.note); }
    @Patch('materials/:sku') updateMaterial(@Param('sku') sku: string, @Body() data: any) { return this.service.updateMaterial(sku, data); }
  @Delete('materials/:sku') deleteMaterial(@Param('sku') sku: string) { return this.service.deleteMaterial(sku); }
  @Get('molds') molds() { return this.service.listMolds(); }
  @Post('molds') createMold(@Body() data: any) { return this.service.createMold(data); }
  @Patch('molds/:code') updateMold(@Param('code') code: string, @Body() data: any) { return this.service.updateMold(code, data); }
  @Delete('molds/:code') deleteMold(@Param('code') code: string) { return this.service.deleteMold(code); }  @Get('machines') machines() { return this.service.listMachines(); }
  @Post('machines') createMachine(@Body() data: any) { return this.service.createMachine(data); }
    @Patch('machines/:code') updateMachine(@Param('code') code: string, @Body() data: any) { return this.service.updateMachine(code, data); }
  @Delete('machines/:code') deleteMachine(@Param('code') code: string) { return this.service.deleteMachine(code); }  @Get('supply-lines') lines() { return this.service.listSupplyLines(); }
  @Post('supply-lines') createLine(@Body() data: any) { return this.service.createSupplyLine(data); }
    @Patch('supply-lines/:code') updateSupplyLine(@Param('code') code: string, @Body() data: any) { return this.service.updateSupplyLine(code, data); }
  @Delete('supply-lines/:code') deleteSupplyLine(@Param('code') code: string) { return this.service.deleteSupplyLine(code); }  @Post('schedule/recommend') recommend(@Body() data: { productSku: string; quantity: number; dueDate?: string | null; orderType?: 'SALES' | 'STOCK'; priorityScore?: number }) { return this.service.recommend(data); }
  @Post('schedule/batch-recommend') batchRecommend(@Body() data: { orders: { productSku: string; quantity: number; dueDate?: string | null; orderType?: 'SALES' | 'STOCK'; priorityScore?: number }[] }) { return this.service.batchRecommend(data); }
  @Post('work-orders/batch') createBatchOrders(@Body() data: { orders: { productSku: string; quantity: number; dueDate?: string | null; orderType?: 'SALES' | 'STOCK'; priorityScore?: number }[] }) { return this.service.createBatchOrders(data); }
  @Get('work-orders') workOrders() { return this.service.listOrders(); }
  @Get('faults') faults() { return this.service.listFaults(); }
  @Patch('work-orders/:id/progress') reportProgress(@Param('id') id: string, @Body() body: { completedQuantity: number }) { return this.service.reportProgress(id, Number(body.completedQuantity)); }
  @Post('work-orders/:id/confirm-overdue') confirmOverdue(@Param('id') id: string) { return this.service.confirmOverdueCompletion(id); }
  @Post('work-orders') createOrder(@Body() data: { productSku: string; quantity: number; dueDate?: string | null; orderType?: 'SALES' | 'STOCK'; priorityScore?: number }) { return this.service.createOrder(data); }
  @Patch('work-orders/:id/schedule') updateSchedule(@Param('id') id: string, @Body() data: { machineCode: string; supplyLineCode: string; moldCode?: string; scheduledStart: string; scheduledEnd: string }) { return this.service.updateSchedule(id, data); }
  @Post('work-orders/:id/split') splitOrder(@Param('id') id: string, @Body() data: { quantity: number }) { return this.service.splitOrder(id, Number(data.quantity)); }
  @Post('faults') createFault(@Body() data: { resourceType: 'MACHINE' | 'SUPPLY_LINE'; resourceCode: string; note: string; estimatedHours: number }) { return this.service.createFault(data); }
  @Post('faults/:id/resolve') resolveFault(@Param('id') id: string) { return this.service.resolveFault(id); }
}




