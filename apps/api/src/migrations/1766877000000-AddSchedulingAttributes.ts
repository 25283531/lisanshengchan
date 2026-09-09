import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddSchedulingAttributes1766877000000 implements MigrationInterface {
  name = 'AddSchedulingAttributes1766877000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "moldCodes" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await q.query(`ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "currentMoldCode" varchar NULL`);
    await q.query(`ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "moldChangeMinutes" integer NOT NULL DEFAULT 45`);
    await q.query(`ALTER TABLE "work_orders" ALTER COLUMN "dueDate" DROP NOT NULL`);
    await q.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "orderType" varchar NOT NULL DEFAULT 'SALES'`);
    await q.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "priorityScore" numeric(10,2) NOT NULL DEFAULT 0`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "priorityScore"`);
    await q.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "orderType"`);
    await q.query(`ALTER TABLE "machines" DROP COLUMN IF EXISTS "moldChangeMinutes"`);
    await q.query(`ALTER TABLE "machines" DROP COLUMN IF EXISTS "currentMoldCode"`);
    await q.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "moldCodes"`);
  }
}
