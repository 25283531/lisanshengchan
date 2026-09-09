import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddWorkOrderSplit1766877200000 implements MigrationInterface {
  name = 'AddWorkOrderSplit1766877200000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "parentOrderCode" varchar NULL`);
    await q.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "splitSequence" integer NOT NULL DEFAULT 1`);
    await q.query(`CREATE INDEX IF NOT EXISTS "IDX_work_orders_parentOrderCode" ON "work_orders" ("parentOrderCode")`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS "IDX_work_orders_parentOrderCode"`);
    await q.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "splitSequence"`);
    await q.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "parentOrderCode"`);
  }
}
