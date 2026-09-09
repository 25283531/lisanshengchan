import { MigrationInterface, QueryRunner } from 'typeorm';
export class InitialSchema1766875800000 implements MigrationInterface {
  name = 'InitialSchema1766875800000';
  async up(q: QueryRunner): Promise<void> {
    await q.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await q.query(`CREATE TABLE "products" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "sku" varchar NOT NULL UNIQUE, "name" varchar NOT NULL, "logoVersion" varchar NOT NULL, "lossRate" numeric(5,2) NOT NULL DEFAULT 0, "recipe" jsonb NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE "materials" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "sku" varchar NOT NULL UNIQUE, "name" varchar NOT NULL, "stockKg" numeric(14,3) NOT NULL DEFAULT 0, "safetyStockKg" numeric(14,3) NOT NULL DEFAULT 0, "createdAt" TIMESTAMP NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE "machines" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "code" varchar NOT NULL UNIQUE, "name" varchar NOT NULL, "moldCodes" jsonb NOT NULL DEFAULT '[]'::jsonb, "productSkus" jsonb NOT NULL DEFAULT '[]'::jsonb, "unitsPerHour" numeric(12,2) NOT NULL, "status" varchar NOT NULL DEFAULT 'AVAILABLE')`);
    await q.query(`CREATE TABLE "supply_lines" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "code" varchar NOT NULL UNIQUE, "name" varchar NOT NULL, "machineCodes" jsonb NOT NULL DEFAULT '[]'::jsonb, "recipeKey" varchar NOT NULL, "minChangeoverMinutes" integer NOT NULL DEFAULT 60, "occupiedUntil" TIMESTAMPTZ NULL, "status" varchar NOT NULL DEFAULT 'AVAILABLE')`);
    await q.query(`CREATE TABLE "work_orders" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "code" varchar NOT NULL UNIQUE, "productSku" varchar NOT NULL, "quantity" integer NOT NULL, "dueDate" date NOT NULL, "status" varchar NOT NULL DEFAULT 'DRAFT', "machineCode" varchar NULL, "supplyLineCode" varchar NULL, "scheduledStart" TIMESTAMPTZ NULL, "scheduledEnd" TIMESTAMPTZ NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE "resource_faults" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "resourceType" varchar NOT NULL, "resourceCode" varchar NOT NULL, "note" varchar NOT NULL, "estimatedHours" numeric(8,2) NOT NULL, "blockedUntil" TIMESTAMPTZ NOT NULL, "status" varchar NOT NULL DEFAULT 'OPEN', "createdAt" TIMESTAMP NOT NULL DEFAULT now())`);
    await q.query(`CREATE TABLE "inventory_transactions" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "materialSku" varchar NOT NULL, "quantityKg" numeric(14,3) NOT NULL, "type" varchar NOT NULL, "referenceCode" varchar NULL, "note" varchar NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now())`);
  }
  async down(q: QueryRunner): Promise<void> { for (const table of ['inventory_transactions','resource_faults','work_orders','supply_lines','machines','materials','products']) await q.query(`DROP TABLE IF EXISTS "${table}"`); }
}
