-- Additive only: preserve every existing table, key, account and historical row.
-- MySQL 8.4 requires an expression for a JSON column default.
ALTER TABLE `Product`
  ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `formSchema` JSON NOT NULL DEFAULT ('{"version":1,"fields":[]}');

CREATE INDEX `Product_archivedAt_sortOrder_createdAt_idx`
  ON `Product`(`archivedAt`, `sortOrder`, `createdAt`);
