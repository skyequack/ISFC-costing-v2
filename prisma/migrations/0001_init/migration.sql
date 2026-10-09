-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "RecipeType" AS ENUM ('MENU', 'SUB');

-- CreateEnum
CREATE TYPE "RecipeStatus" AS ENUM ('DRAFT', 'LOCKED');

-- CreateEnum
CREATE TYPE "HistoryAction" AS ENUM ('LOCK', 'UNLOCK');

-- CreateEnum
CREATE TYPE "MenuCellKind" AS ENUM ('ITEM', 'RECIPE', 'NONE');

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "legacyId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "color" TEXT NOT NULL DEFAULT '',
    "inkColor" TEXT,
    "locations" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "clerkUserId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastRoleSeen" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBrandAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,

    CONSTRAINT "UserBrandAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "priceUpdatedAt" TIMESTAMPTZ,
    "category" TEXT NOT NULL,
    "subcategory" TEXT NOT NULL,
    "flag" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemBrandScope" (
    "ingredientId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,

    CONSTRAINT "ItemBrandScope_pkey" PRIMARY KEY ("ingredientId","brandId")
);

-- CreateTable
CREATE TABLE "UnitConversion" (
    "ingredientId" TEXT NOT NULL,
    "recipeUnit" TEXT NOT NULL,
    "factor" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "UnitConversion_pkey" PRIMARY KEY ("ingredientId")
);

-- CreateTable
CREATE TABLE "IngredientPriceHistory" (
    "id" TEXT NOT NULL,
    "ingredientId" TEXT NOT NULL,
    "oldPrice" DOUBLE PRECISION,
    "newPrice" DOUBLE PRECISION,
    "source" TEXT NOT NULL,
    "userId" TEXT,
    "userNameSnapshot" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngredientPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "type" "RecipeType" NOT NULL,
    "brandId" TEXT NOT NULL,
    "output" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "subQty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "subUom" TEXT NOT NULL DEFAULT 'Gram',
    "batchOut" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "batchUom" TEXT NOT NULL DEFAULT 'Gram',
    "sellingPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "buffer" DOUBLE PRECISION,
    "status" "RecipeStatus" NOT NULL DEFAULT 'DRAFT',
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMPTZ,
    "lockedByUserId" TEXT,
    "costAtLock" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMPTZ,
    "deletedBy" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipePhoto" (
    "recipeId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "RecipePhoto_pkey" PRIMARY KEY ("recipeId")
);

-- CreateTable
CREATE TABLE "BrandLogo" (
    "brandId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "BrandLogo_pkey" PRIMARY KEY ("brandId")
);

-- CreateTable
CREATE TABLE "RecipeLine" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "y" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "yp" DOUBLE PRECISION,

    CONSTRAINT "RecipeLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeMethodStep" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "RecipeMethodStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecipeHistoryEntry" (
    "id" TEXT NOT NULL,
    "recipeId" TEXT NOT NULL,
    "action" "HistoryAction" NOT NULL,
    "who" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipeHistoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "currency" TEXT NOT NULL DEFAULT 'SAR',
    "pkg" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "del" DOUBLE PRECISION NOT NULL DEFAULT 0.10,
    "lab" DOUBLE PRECISION NOT NULL DEFAULT 0.25,
    "ops" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "buffer" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "target" DOUBLE PRECISION NOT NULL DEFAULT 0.30,
    "vat" DOUBLE PRECISION NOT NULL DEFAULT 0.15,
    "priceDate" DATE NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CostSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "userNameSnapshot" TEXT NOT NULL,
    "roleSnapshot" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Menu" (
    "id" TEXT NOT NULL,
    "legacyIndex" INTEGER,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "days" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "Menu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuRow" (
    "id" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "meal" TEXT NOT NULL,

    CONSTRAINT "MenuRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuCell" (
    "id" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "kind" "MenuCellKind" NOT NULL,
    "code" TEXT,
    "label" TEXT NOT NULL,

    CONSTRAINT "MenuCell_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuPax" (
    "month" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "menuId" TEXT NOT NULL,
    "people" INTEGER NOT NULL,

    CONSTRAINT "MenuPax_pkey" PRIMARY KEY ("month","day","location","menuId")
);

-- CreateTable
CREATE TABLE "ProductionEntry" (
    "month" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "recipeCode" TEXT NOT NULL,
    "portions" INTEGER NOT NULL,

    CONSTRAINT "ProductionEntry_pkey" PRIMARY KEY ("month","day","location","recipeCode")
);

-- CreateTable
CREATE TABLE "SeedRun" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeedRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brand_legacyId_key" ON "Brand"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_code_key" ON "Brand"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_name_key" ON "Brand"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_clerkUserId_key" ON "User"("clerkUserId");

-- CreateIndex
CREATE INDEX "UserBrandAccess_brandId_idx" ON "UserBrandAccess"("brandId");

-- CreateIndex
CREATE UNIQUE INDEX "UserBrandAccess_userId_brandId_key" ON "UserBrandAccess"("userId", "brandId");

-- CreateIndex
CREATE UNIQUE INDEX "Ingredient_code_key" ON "Ingredient"("code");

-- CreateIndex
CREATE INDEX "IngredientPriceHistory_ingredientId_createdAt_idx" ON "IngredientPriceHistory"("ingredientId", "createdAt");

-- CreateIndex
CREATE INDEX "Recipe_brandId_deletedAt_idx" ON "Recipe"("brandId", "deletedAt");

-- CreateIndex
CREATE INDEX "RecipeLine_code_idx" ON "RecipeLine"("code");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeLine_recipeId_sortOrder_key" ON "RecipeLine"("recipeId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RecipeMethodStep_recipeId_stepNumber_key" ON "RecipeMethodStep"("recipeId", "stepNumber");

-- CreateIndex
CREATE INDEX "RecipeHistoryEntry_recipeId_createdAt_idx" ON "RecipeHistoryEntry"("recipeId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Menu_legacyIndex_key" ON "Menu"("legacyIndex");

-- CreateIndex
CREATE UNIQUE INDEX "Menu_name_key" ON "Menu"("name");

-- CreateIndex
CREATE UNIQUE INDEX "MenuRow_menuId_sortOrder_key" ON "MenuRow"("menuId", "sortOrder");

-- CreateIndex
CREATE INDEX "MenuCell_code_idx" ON "MenuCell"("code");

-- CreateIndex
CREATE UNIQUE INDEX "MenuCell_rowId_day_key" ON "MenuCell"("rowId", "day");

-- CreateIndex
CREATE INDEX "ProductionEntry_recipeCode_idx" ON "ProductionEntry"("recipeCode");

-- AddForeignKey
ALTER TABLE "UserBrandAccess" ADD CONSTRAINT "UserBrandAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBrandAccess" ADD CONSTRAINT "UserBrandAccess_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemBrandScope" ADD CONSTRAINT "ItemBrandScope_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemBrandScope" ADD CONSTRAINT "ItemBrandScope_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitConversion" ADD CONSTRAINT "UnitConversion_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngredientPriceHistory" ADD CONSTRAINT "IngredientPriceHistory_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "Ingredient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipePhoto" ADD CONSTRAINT "RecipePhoto_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandLogo" ADD CONSTRAINT "BrandLogo_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeLine" ADD CONSTRAINT "RecipeLine_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeMethodStep" ADD CONSTRAINT "RecipeMethodStep_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipeHistoryEntry" ADD CONSTRAINT "RecipeHistoryEntry_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES "Recipe"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuRow" ADD CONSTRAINT "MenuRow_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuCell" ADD CONSTRAINT "MenuCell_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "MenuRow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuPax" ADD CONSTRAINT "MenuPax_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "Menu"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===== Raw SQL additions (schema.md) =====
CREATE UNIQUE INDEX recipe_code_lower_live ON "Recipe"(lower(code)) WHERE "deletedAt" IS NULL;
ALTER TABLE "Ingredient" ADD CHECK (price IS NULL OR (price >= 0 AND price < 'Infinity'));
ALTER TABLE "Ingredient" ADD CHECK (uom IN ('Gram','Ml','Each','Slice'));
ALTER TABLE "RecipeLine" ADD CHECK (qty >= 0 AND qty < 'Infinity' AND y > 0);
ALTER TABLE "UnitConversion" ADD CHECK (factor > 0);
ALTER TABLE "ProductionEntry" ADD CHECK (portions >= 0);
ALTER TABLE "MenuPax" ADD CHECK (people >= 0);
ALTER TABLE "RecipePhoto" ADD CHECK (size > 0 AND size <= 1500000 AND width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096);
ALTER TABLE "BrandLogo" ADD CHECK (size > 0 AND size <= 512000 AND width BETWEEN 1 AND 1024 AND height BETWEEN 1 AND 1024);
ALTER TABLE "MenuCell" ADD CHECK ((kind = 'NONE') = (code IS NULL));
CREATE FUNCTION audit_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'AuditLog is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_mutate BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE TRIGGER audit_no_truncate BEFORE TRUNCATE ON "AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION audit_immutable();
