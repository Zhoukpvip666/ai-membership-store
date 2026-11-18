-- Refuse unsupported legacy suspended entitlements BEFORE changing persistent data/schema.
-- The CLI preflight reports the count and IDs. This guard also protects direct Prisma use.
CREATE TEMPORARY TABLE `_phase2_suspended_guard` (
  `blocked` INT NOT NULL,
  CONSTRAINT `phase2_requires_no_suspended_subscriptions` CHECK (`blocked` = 0)
);
INSERT INTO `_phase2_suspended_guard` (`blocked`)
SELECT 1 FROM `Subscription` WHERE `status` = 'SUSPENDED';
DROP TEMPORARY TABLE `_phase2_suspended_guard`;

ALTER TABLE `User`
  CHANGE COLUMN `displayName` `adminLabel` VARCHAR(80) NULL,
  ADD COLUMN `username` VARCHAR(80) NULL;

ALTER TABLE `Subscription`
  MODIFY COLUMN `sourceType` VARCHAR(32) NOT NULL,
  MODIFY COLUMN `targetIdentifier` VARCHAR(254) NULL,
  MODIFY COLUMN `createdByAdminId` VARCHAR(36) NULL,
  ADD COLUMN `productNameSnapshot` VARCHAR(120) NULL,
  ADD COLUMN `productDescriptionSnapshot` TEXT NULL,
  ADD COLUMN `productTypeSnapshot` ENUM('SUBSCRIPTION','ONE_TIME') NULL,
  ADD COLUMN `priceSnapshotFen` INTEGER NULL,
  ADD COLUMN `termSnapshot` VARCHAR(40) NULL,
  ADD COLUMN `formSchemaSnapshot` JSON NOT NULL DEFAULT ('{"version":1,"fields":[]}'),
  ADD COLUMN `formData` JSON NOT NULL DEFAULT ('{}'),
  ADD COLUMN `note` VARCHAR(2000) NULL,
  ADD COLUMN `terminatedAt` DATETIME(3) NULL,
  ADD COLUMN `terminationReason` VARCHAR(500) NULL,
  ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1;

-- Old records lack historical product/form snapshots. Freeze the referenced product
-- at migration time, without claiming to recover an earlier price/configuration.
UPDATE `Subscription` s JOIN `Product` p ON p.id = s.productId
SET s.productNameSnapshot = p.name,
    s.productDescriptionSnapshot = p.description,
    s.productTypeSnapshot = p.type,
    s.priceSnapshotFen = p.priceFen,
    s.termSnapshot = p.termLabel,
    s.formSchemaSnapshot = p.formSchema,
    s.sourceType = 'ADMIN';

ALTER TABLE `Subscription`
  MODIFY COLUMN `sourceType` ENUM('ADMIN','SYSTEM') NOT NULL,
  MODIFY COLUMN `status` ENUM('ACTIVE','TERMINATED') NOT NULL DEFAULT 'ACTIVE',
  MODIFY COLUMN `productNameSnapshot` VARCHAR(120) NOT NULL,
  MODIFY COLUMN `productTypeSnapshot` ENUM('SUBSCRIPTION','ONE_TIME') NOT NULL,
  MODIFY COLUMN `priceSnapshotFen` INTEGER NOT NULL,
  MODIFY COLUMN `termSnapshot` VARCHAR(40) NOT NULL,
  ADD INDEX `Subscription_productId_status_idx` (`productId`,`status`),
  ADD INDEX `Subscription_sourceType_createdAt_idx` (`sourceType`,`createdAt`);

-- Retain all historical event types and date columns; new operations emit the new vocabulary.
ALTER TABLE `SubscriptionEvent`
  MODIFY COLUMN `eventType` ENUM('CREATED','ACTIVATED','RENEWED','EXPIRY_ADJUSTED','MANUAL_GRANT','HISTORICAL_IMPORT','SUSPENDED','RESUMED','TERMINATED','NOTE','UPDATED','PRICE_CHANGED','FORM_DATA_UPDATED','AUTO_TERMINATED') NOT NULL,
  MODIFY COLUMN `actorAdminId` VARCHAR(36) NULL,
  ADD COLUMN `actorType` ENUM('ADMIN','SYSTEM') NOT NULL DEFAULT 'ADMIN',
  ADD COLUMN `beforeJson` JSON NULL,
  ADD COLUMN `afterJson` JSON NULL;

ALTER TABLE `AdminAuditLog`
  MODIFY COLUMN `actorAdminId` VARCHAR(36) NULL,
  ADD COLUMN `actorType` ENUM('ADMIN','SYSTEM') NOT NULL DEFAULT 'ADMIN';

CREATE TABLE `IdempotencyRecord` (
  `id` VARCHAR(36) NOT NULL,
  `actorAdminId` VARCHAR(36) NOT NULL,
  `keyHash` VARCHAR(64) NOT NULL,
  `requestHash` VARCHAR(64) NOT NULL,
  `operation` VARCHAR(160) NOT NULL,
  `responseJson` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `IdempotencyRecord_actorAdminId_keyHash_key` (`actorAdminId`,`keyHash`),
  CONSTRAINT `IdempotencyRecord_actorAdminId_fkey` FOREIGN KEY (`actorAdminId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
