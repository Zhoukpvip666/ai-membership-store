-- Incremental foundation only. First ten migrations are immutable.
-- Each MySQL DDL statement commits independently: stop on failure; inspect actual
-- schema/triggers and _prisma_migrations before DBA-directed recovery. Never reset.
-- Trigger creation needs TRIGGER plus the existing binlog/DEFINER DBA preflight.
-- No historical revisions or payment/actor facts are fabricated.
ALTER TABLE `Order` ADD COLUMN `version` INTEGER NOT NULL DEFAULT 1,
    ADD CONSTRAINT `Order_version_check` CHECK (`version` >= 1);

-- Rename in place: preserve every row, ID, hash, operation, response and date.
ALTER TABLE `IdempotencyRecord`
    DROP FOREIGN KEY `IdempotencyRecord_actorAdminId_fkey`,
    RENAME COLUMN `actorAdminId` TO `actorUserId`,
    RENAME INDEX `IdempotencyRecord_actorAdminId_keyHash_key` TO `IdempotencyRecord_actorUserId_keyHash_key`,
    ADD CONSTRAINT `IdempotencyRecord_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE `OrderRevision` (
    `id` VARCHAR(36) NOT NULL,
    `orderId` VARCHAR(36) NOT NULL,
    `version` INTEGER NOT NULL,
    `snapshotSchemaVersion` INTEGER NOT NULL,
    `snapshotJson` JSON NOT NULL,
    `actorUserId` VARCHAR(36) NULL,
    `actorType` ENUM('USER','ADMIN','SYSTEM') NOT NULL,
    `reason` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE INDEX `OrderRevision_orderId_version_key` (`orderId`, `version`),
    INDEX `OrderRevision_orderId_createdAt_idx` (`orderId`, `createdAt`),
    INDEX `OrderRevision_actorUserId_createdAt_idx` (`actorUserId`, `createdAt`),
    CONSTRAINT `OrderRevision_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT `OrderRevision_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT `OrderRevision_actor_check` CHECK (
      CAST(`actorType` AS BINARY) IN ('USER','ADMIN','SYSTEM') AND
      ((`actorType` IN ('USER','ADMIN') AND `actorUserId` IS NOT NULL) OR `actorType` = 'SYSTEM')
    ),
    CONSTRAINT `OrderRevision_version_check` CHECK (`version` >= 1 AND `snapshotSchemaVersion` = 1),
    CONSTRAINT `OrderRevision_snapshot_check` CHECK (
      JSON_SCHEMA_VALID('{"type":"object","required":["snapshotSchemaVersion","order"],"additionalProperties":false,"properties":{"snapshotSchemaVersion":{"type":"integer","enum":[1]},"order":{"type":"object","required":["id","orderNo","userId","productId","productNameSnapshot","termSnapshot","contactEmailSnapshot","subscriptionId","productDescriptionSnapshot","targetIdentifier","cancellationReason","internalNote","createdByAdminId","createdByUserId","billingTimezoneSnapshot","amountFen","version","priceSnapshotFen","servicePeriodCountSnapshot","renewalPriceSnapshotFen","billingRevisionSnapshot","createdAt","updatedAt","paidAt","paymentRecordedAt","paymentConfirmedAt","fulfilledAt","cancelledAt","renewalPeriodStartAt","renewalPeriodEndAt","renewalForPeriodStartAt","billingAnchorSnapshotAt","kind","source","productTypeSnapshot","paymentStatus","fulfillmentStatus","servicePeriodUnitSnapshot","hidden","formSchemaSnapshot","formData"],"additionalProperties":false,"properties":{"id":{"type":"string"},"orderNo":{"type":"string"},"userId":{"type":"string"},"productId":{"type":"string"},"productNameSnapshot":{"type":"string"},"termSnapshot":{"type":"string"},"contactEmailSnapshot":{"type":"string"},"subscriptionId":{"type":["string","null"]},"productDescriptionSnapshot":{"type":["string","null"]},"targetIdentifier":{"type":["string","null"]},"cancellationReason":{"type":["string","null"]},"internalNote":{"type":["string","null"]},"createdByAdminId":{"type":["string","null"]},"createdByUserId":{"type":["string","null"]},"billingTimezoneSnapshot":{"type":["string","null"]},"amountFen":{"type":"integer","minimum":0},"version":{"type":"integer","minimum":1},"priceSnapshotFen":{"type":["integer","null"]},"servicePeriodCountSnapshot":{"type":["integer","null"]},"renewalPriceSnapshotFen":{"type":["integer","null"]},"billingRevisionSnapshot":{"type":["integer","null"]},"createdAt":{"type":"string"},"updatedAt":{"type":"string"},"paidAt":{"type":["string","null"]},"paymentRecordedAt":{"type":["string","null"]},"paymentConfirmedAt":{"type":["string","null"]},"fulfilledAt":{"type":["string","null"]},"cancelledAt":{"type":["string","null"]},"renewalPeriodStartAt":{"type":["string","null"]},"renewalPeriodEndAt":{"type":["string","null"]},"renewalForPeriodStartAt":{"type":["string","null"]},"billingAnchorSnapshotAt":{"type":["string","null"]},"kind":{"type":"string","enum":["INITIAL","RENEWAL","ONE_TIME"]},"source":{"type":"string","enum":["USER","ADMIN","SYSTEM_RENEWAL"]},"productTypeSnapshot":{"type":"string","enum":["SUBSCRIPTION","ONE_TIME"]},"paymentStatus":{"type":"string","enum":["UNPAID","PENDING_VERIFICATION","PAID","REFUND_PENDING","REFUNDED"]},"fulfillmentStatus":{"type":"string","enum":["NOT_STARTED","PROCESSING","COMPLETED","FAILED","CANCELLED"]},"servicePeriodUnitSnapshot":{"type":["string","null"],"enum":["DAY","MONTH","YEAR",null]},"hidden":{"type":"boolean"},"formSchemaSnapshot":{},"formData":{}}}}}', `snapshotJson`)
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(`snapshotJson`, '$.order.id')) AS BINARY) = CAST(`orderId` AS BINARY)
      AND JSON_EXTRACT(`snapshotJson`, '$.order.version') = `version`
      AND JSON_EXTRACT(`snapshotJson`, '$.snapshotSchemaVersion') = `snapshotSchemaVersion`
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TRIGGER `Order_version_insert` BEFORE INSERT ON `Order`
FOR EACH ROW FOLLOWS `Order_new_source_insert`
BEGIN
  IF NEW.`version` IS NULL OR NEW.`version` <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_INITIAL_VERSION_REQUIRED';
  END IF;
END;

CREATE TRIGGER `Order_version_update` BEFORE UPDATE ON `Order`
FOR EACH ROW FOLLOWS `Order_source_immutable_update`
BEGIN
  IF NEW.`version` IS NULL OR NEW.`version` <> OLD.`version` + 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_VERSION_MUST_INCREMENT_ONCE';
  END IF;
END;

-- Serialize the snapshot version check with writes of the parent order. This is
-- not a substitute for the future service's atomic Order/revision/event/audit transaction.
CREATE TRIGGER `OrderRevision_current_version_insert` BEFORE INSERT ON `OrderRevision`
FOR EACH ROW
BEGIN
  DECLARE currentVersion INTEGER DEFAULT NULL;
  SELECT `version` INTO currentVersion FROM `Order` WHERE `id` = NEW.`orderId` FOR SHARE;
  IF currentVersion IS NOT NULL AND NOT (NEW.`version` <=> currentVersion) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_REVISION_CURRENT_VERSION_REQUIRED';
  END IF;
END;

CREATE TRIGGER `OrderRevision_immutable_update` BEFORE UPDATE ON `OrderRevision`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_REVISION_IMMUTABLE';
END;

CREATE TRIGGER `OrderRevision_immutable_delete` BEFORE DELETE ON `OrderRevision`
FOR EACH ROW
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_REVISION_IMMUTABLE';
END;
