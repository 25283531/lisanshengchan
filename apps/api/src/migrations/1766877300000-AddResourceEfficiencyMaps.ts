import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddResourceEfficiencyMaps1766877300000 implements MigrationInterface {
  name = 'AddResourceEfficiencyMaps1766877300000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "molds" ADD COLUMN IF NOT EXISTS "machineEfficiencies" jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await q.query(`ALTER TABLE "machines" ADD COLUMN IF NOT EXISTS "moldEfficiencies" jsonb NOT NULL DEFAULT '[]'::jsonb`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "machines" DROP COLUMN IF EXISTS "moldEfficiencies"`);
    await q.query(`ALTER TABLE "molds" DROP COLUMN IF EXISTS "machineEfficiencies"`);
  }
}
