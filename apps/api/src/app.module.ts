import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductionModule } from './production/production.module.js';
import { InventoryTransaction, Machine, Material, Mold, Product, ResourceFault, SupplyLine, WorkOrder } from './production/entities.js';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), TypeOrmModule.forRootAsync({ inject: [ConfigService], useFactory: (config: ConfigService) => ({ type: 'postgres', host: config.get('DB_HOST', 'localhost'), port: Number(config.get('DB_PORT', 5432)), username: config.get('DB_USER', 'mes'), password: config.get('DB_PASSWORD', 'mes_dev_password'), database: config.get('DB_NAME', 'mes'), entities: [Product, Material, Mold, Machine, SupplyLine, WorkOrder, ResourceFault, InventoryTransaction], synchronize: false }) }), ProductionModule] })
export class AppModule {}


