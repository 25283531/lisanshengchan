import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('products')
export class Product {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ unique: true }) sku!: string;
  @Column() name!: string;
  @Column() logoVersion!: string;
  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 }) lossRate!: number;
  @Column({ type: 'jsonb' }) recipe!: { materialSku: string; gramsPerUnit: number }[];
  @Column({ type: 'jsonb', default: [] }) moldCodes!: string[];
  @CreateDateColumn() createdAt!: Date;
  @UpdateDateColumn() updatedAt!: Date;
}

@Entity('materials')
export class Material {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ unique: true }) sku!: string;
  @Column() name!: string;
  @Column({ type: 'decimal', precision: 14, scale: 3, default: 0 }) stockKg!: number;
  @Column({ type: 'decimal', precision: 14, scale: 3, default: 0 }) safetyStockKg!: number;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('molds')
export class Mold {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ unique: true }) code!: string;
  @Column() name!: string;
  @Column({ type: 'integer' }) cavities!: number;
  @Column({ default: 'AVAILABLE' }) status!: 'AVAILABLE' | 'MAINTENANCE' | 'RETIRED';
  @Column({ type: 'integer', default: 0 }) cumulativeShots!: number;
  @Column({ type: 'integer', default: 0 }) maintenanceAtShots!: number;
  @Column({ type: 'jsonb', default: [] }) machineEfficiencies!: { machineCode: string; unitsPerHour: number }[];
}
@Entity('machines')
export class Machine {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ unique: true }) code!: string;
  @Column() name!: string;
  @Column({ type: 'jsonb', default: [] }) moldCodes!: string[];
  @Column({ nullable: true }) currentMoldCode!: string | null;
  @Column({ type: 'integer', default: 45 }) moldChangeMinutes!: number;
  @Column({ type: 'jsonb', default: [] }) productSkus!: string[];
  @Column({ type: 'jsonb', default: [] }) moldEfficiencies!: { moldCode: string; unitsPerHour: number }[];
  @Column({ type: 'decimal', precision: 12, scale: 2 }) unitsPerHour!: number;
  @Column({ default: 'AVAILABLE' }) status!: 'AVAILABLE' | 'FAULT' | 'MAINTENANCE';
}

@Entity('supply_lines')
export class SupplyLine {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ unique: true }) code!: string;
  @Column() name!: string;
  @Column({ type: 'jsonb', default: [] }) machineCodes!: string[];
  @Column() recipeKey!: string;
  @Column({ default: 60 }) minChangeoverMinutes!: number;
  @Column({ type: 'timestamptz', nullable: true }) occupiedUntil!: Date | null;
  @Column({ default: 'AVAILABLE' }) status!: 'AVAILABLE' | 'FAULT' | 'MAINTENANCE';
}

@Entity('work_orders')
export class WorkOrder {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ unique: true }) code!: string;
  @Column() productSku!: string;
  @Column({ type: 'integer' }) quantity!: number;
  @Column({ type: 'date', nullable: true }) dueDate!: string | null;
  @Column({ default: 'SALES' }) orderType!: 'SALES' | 'STOCK';
  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0 }) priorityScore!: number;
  @Column({ default: 'DRAFT' }) status!: 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'COMPLETED';
  @Column({ nullable: true }) machineCode!: string | null;
  @Column({ nullable: true }) supplyLineCode!: string | null;
  @Column({ nullable: true }) assignedMoldCode!: string | null;
  @Column({ nullable: true }) parentOrderCode!: string | null;
  @Column({ type: 'integer', default: 1 }) splitSequence!: number;
  @Column({ type: 'timestamptz', nullable: true }) scheduledStart!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) scheduledEnd!: Date | null;
  @CreateDateColumn() createdAt!: Date;
}

@Entity('resource_faults')
export class ResourceFault {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() resourceType!: 'MACHINE' | 'SUPPLY_LINE';
  @Column() resourceCode!: string;
  @Column() note!: string;
  @Column({ type: 'decimal', precision: 8, scale: 2 }) estimatedHours!: number;
  @Column({ type: 'timestamptz' }) blockedUntil!: Date;
  @Column({ default: 'OPEN' }) status!: 'OPEN' | 'RESOLVED';
  @CreateDateColumn() createdAt!: Date;
}

@Entity('inventory_transactions')
export class InventoryTransaction {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column() materialSku!: string;
  @Column({ type: 'decimal', precision: 14, scale: 3 }) quantityKg!: number;
  @Column() type!: 'RECEIPT' | 'MANUAL_USE' | 'PRODUCTION_RESERVE' | 'ADJUSTMENT';
  @Column({ nullable: true }) referenceCode!: string | null;
  @Column({ nullable: true }) note!: string | null;
  @CreateDateColumn() createdAt!: Date;
}



