-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "isAutomatic" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'failed';
