import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSupplyLineMixer1766877600000 implements MigrationInterface {
  name = 'AddSupplyLineMixer1766877600000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "supply_lines" ADD COLUMN IF NOT EXISTS "mixerCode" character varying`);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE "supply_lines" DROP COLUMN IF EXISTS "mixerCode"`);
  }
}
