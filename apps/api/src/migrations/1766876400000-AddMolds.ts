import { MigrationInterface, QueryRunner } from 'typeorm';
export class AddMolds1766876400000 implements MigrationInterface {
  name = 'AddMolds1766876400000';
  async up(q: QueryRunner): Promise<void> { await q.query(`CREATE TABLE "molds" ("id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "code" varchar NOT NULL UNIQUE, "name" varchar NOT NULL, "cavities" integer NOT NULL, "status" varchar NOT NULL DEFAULT 'AVAILABLE', "cumulativeShots" integer NOT NULL DEFAULT 0, "maintenanceAtShots" integer NOT NULL DEFAULT 0)`); }
  async down(q: QueryRunner): Promise<void> { await q.query('DROP TABLE IF EXISTS "molds"'); }
}
