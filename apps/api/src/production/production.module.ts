import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryTransaction, Machine, Material, Mold, Product, ResourceFault, SupplyLine, WorkOrder } from './entities.js';
import { ProductionController } from './production.controller.js';
import { DemoSeedService } from './demo-seed.service.js';
import { ProductionService } from './production.service.js';
@Module({ imports: [TypeOrmModule.forFeature([Product, Material, Mold, Machine, SupplyLine, WorkOrder, ResourceFault, InventoryTransaction])], controllers: [ProductionController], providers: [ProductionService, DemoSeedService] })
export class ProductionModule {}


