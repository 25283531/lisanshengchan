import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFinishedStock1766877500000 implements MigrationInterface {
  name = 'AddFinishedStock1766877500000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "finishedStockQuantity" integer NOT NULL DEFAULT 0`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "products" DROP COLUMN IF EXISTS "finishedStockQuantity"`);
  }
}
