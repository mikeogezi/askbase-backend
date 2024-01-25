/*
  Warnings:

  - The `status` column on the `Payment` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "Status" AS ENUM ('unknown', 'initiated', 'pending', 'succeeded', 'failed');

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "status",
ADD COLUMN     "status" "Status" NOT NULL DEFAULT 'initiated';
