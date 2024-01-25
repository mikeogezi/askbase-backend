/*
  Warnings:

  - You are about to drop the column `isAutomatic` on the `Payment` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "isAutomatic",
ADD COLUMN     "isAutoRenewal" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "currency" SET DEFAULT 'usd',
ALTER COLUMN "period" SET DEFAULT 'monthly';
