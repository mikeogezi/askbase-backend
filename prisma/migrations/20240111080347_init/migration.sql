/*
  Warnings:

  - Added the required column `period` to the `Payment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `plan` to the `Payment` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "Period" AS ENUM ('MONTHLY', 'YEARLY');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "period" "Period" NOT NULL,
ADD COLUMN     "plan" "Plan" NOT NULL;
