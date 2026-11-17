-- Normalize previously archived products before removing obsolete permissions.
-- Preserve all products, references, form schemas and historical records.
UPDATE `Product` SET `listed` = false WHERE `archivedAt` IS NOT NULL;

ALTER TABLE `Product`
  DROP COLUMN `purchaseEnabled`,
  DROP COLUMN `renewalEnabled`;
