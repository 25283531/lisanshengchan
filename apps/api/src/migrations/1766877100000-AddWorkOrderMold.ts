import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddWorkOrderMold1766877100000 implements MigrationInterface {
  name = 'AddWorkOrderMold1766877100000';
  async up(q: QueryRunner): Promise<void> { await q.query(`ALTER TABLE "work_orders" ADD COLUMN IF NOT EXISTS "assignedMoldCode" varchar NULL`); }
  async down(q: QueryRunner): Promise<void> { await q.query(`ALTER TABLE "work_orders" DROP COLUMN IF EXISTS "assignedMoldCode"`); }
}
