import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddWorkOrderProgress1766877400000 implements MigrationInterface {
  name = 'AddWorkOrderProgress1766877400000';
  async up(q: QueryRunner): Promise<void> { await q.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "completedQuantity" integer NOT NULL DEFAULT 0`); }
  async down(q: QueryRunner): Promise<void> { await q.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "completedQuantity"`); }
}
