import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { InventoryTransaction, Machine, Material, Mold, Product, ResourceFault, SupplyLine, WorkOrder } from './production/entities.js';
import { InitialSchema1766875800000 } from './migrations/1766875800000-InitialSchema.js';
import { AddMolds1766876400000 } from './migrations/1766876400000-AddMolds.js';
import { AddSchedulingAttributes1766877000000 } from './migrations/1766877000000-AddSchedulingAttributes.js';
import { AddWorkOrderMold1766877100000 } from './migrations/1766877100000-AddWorkOrderMold.js';
import { AddWorkOrderSplit1766877200000 } from './migrations/1766877200000-AddWorkOrderSplit.js';
import { AddResourceEfficiencyMaps1766877300000 } from './migrations/1766877300000-AddResourceEfficiencyMaps.js';
export default new DataSource({ type: 'postgres', host: process.env.DB_HOST ?? 'localhost', port: Number(process.env.DB_PORT ?? 5432), username: process.env.DB_USER ?? 'mes', password: process.env.DB_PASSWORD ?? 'mes_dev_password', database: process.env.DB_NAME ?? 'mes', entities: [Product, Material, Mold, Machine, SupplyLine, WorkOrder, ResourceFault, InventoryTransaction], migrations: [InitialSchema1766875800000, AddMolds1766876400000, AddSchedulingAttributes1766877000000, AddWorkOrderMold1766877100000, AddWorkOrderSplit1766877200000, AddResourceEfficiencyMaps1766877300000], synchronize: false });



