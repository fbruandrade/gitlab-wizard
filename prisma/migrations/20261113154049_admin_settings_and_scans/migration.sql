-- CreateEnum
CREATE TYPE "AdminScanKind" AS ENUM ('CLEANUP', 'PAT_LIFETIME');

-- CreateEnum
CREATE TYPE "AdminScanStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "app_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" TEXT,

    CONSTRAINT "app_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "admin_scan" (
    "id" UUID NOT NULL,
    "kind" "AdminScanKind" NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" "AdminScanStatus" NOT NULL DEFAULT 'RUNNING',
    "progress" JSONB,
    "items" JSONB,
    "summary" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "admin_scan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_scan_actor_user_id_created_at_idx" ON "admin_scan"("actor_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "admin_scan" ADD CONSTRAINT "admin_scan_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
