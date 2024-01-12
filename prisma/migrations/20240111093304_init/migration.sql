/*
  Warnings:

  - The values [MONTHLY,YEARLY] on the enum `Period` will be removed. If these variants are still used in the database, this will fail.
  - The values [FREE,BASIC,PRO] on the enum `Plan` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "Period_new" AS ENUM ('monthly', 'yearly');
ALTER TABLE "Payment" ALTER COLUMN "period" TYPE "Period_new" USING ("period"::text::"Period_new");
ALTER TYPE "Period" RENAME TO "Period_old";
ALTER TYPE "Period_new" RENAME TO "Period";
DROP TYPE "Period_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "Plan_new" AS ENUM ('free', 'basic', 'pro');
ALTER TABLE "User" ALTER COLUMN "currentPlan" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "currentPlan" TYPE "Plan_new" USING ("currentPlan"::text::"Plan_new");
ALTER TABLE "Payment" ALTER COLUMN "plan" TYPE "Plan_new" USING ("plan"::text::"Plan_new");
ALTER TYPE "Plan" RENAME TO "Plan_old";
ALTER TYPE "Plan_new" RENAME TO "Plan";
DROP TYPE "Plan_old";
ALTER TABLE "User" ALTER COLUMN "currentPlan" SET DEFAULT 'free';
COMMIT;

-- AlterTable
ALTER TABLE "User" ALTER COLUMN "currentPlan" SET DEFAULT 'free';
