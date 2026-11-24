-- DDL commits per statement. If a step fails, inspect before continuing.
-- Check existing ACTIVE credentials before changing other tables or clearing any email.
ALTER TABLE `User`
    MODIFY `loginEmail` VARCHAR(254) NULL,
    ADD CONSTRAINT `User_active_credentials_check` CHECK (
      `status` <> 'ACTIVE' OR
      (`loginEmail` IS NOT NULL
       AND REGEXP_LIKE(`loginEmail`, '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
       AND `activatedAt` IS NOT NULL
       AND `passwordHash` IS NOT NULL AND CHAR_LENGTH(TRIM(`passwordHash`)) > 0)
    );

-- Existing frozen contact values stay unchanged.
ALTER TABLE `Order` MODIFY `contactEmailSnapshot` VARCHAR(254) NULL;

-- Extend V1 only to allow a NULL contact snapshot. Retain the complete whitelist.
ALTER TABLE `OrderRevision` DROP CHECK `OrderRevision_snapshot_check`,
    ADD CONSTRAINT `OrderRevision_snapshot_check` CHECK (
      JSON_SCHEMA_VALID('{"type":"object","required":["snapshotSchemaVersion","order"],"additionalProperties":false,"properties":{"snapshotSchemaVersion":{"type":"integer","enum":[1]},"order":{"type":"object","required":["id","orderNo","userId","productId","productNameSnapshot","termSnapshot","contactEmailSnapshot","subscriptionId","productDescriptionSnapshot","targetIdentifier","cancellationReason","internalNote","createdByAdminId","createdByUserId","billingTimezoneSnapshot","amountFen","version","priceSnapshotFen","servicePeriodCountSnapshot","renewalPriceSnapshotFen","billingRevisionSnapshot","createdAt","updatedAt","paidAt","paymentRecordedAt","paymentConfirmedAt","fulfilledAt","cancelledAt","renewalPeriodStartAt","renewalPeriodEndAt","renewalForPeriodStartAt","billingAnchorSnapshotAt","kind","source","productTypeSnapshot","paymentStatus","fulfillmentStatus","servicePeriodUnitSnapshot","hidden","formSchemaSnapshot","formData"],"additionalProperties":false,"properties":{"id":{"type":"string"},"orderNo":{"type":"string"},"userId":{"type":"string"},"productId":{"type":"string"},"productNameSnapshot":{"type":"string"},"termSnapshot":{"type":"string"},"contactEmailSnapshot":{"type":["string","null"]},"subscriptionId":{"type":["string","null"]},"productDescriptionSnapshot":{"type":["string","null"]},"targetIdentifier":{"type":["string","null"]},"cancellationReason":{"type":["string","null"]},"internalNote":{"type":["string","null"]},"createdByAdminId":{"type":["string","null"]},"createdByUserId":{"type":["string","null"]},"billingTimezoneSnapshot":{"type":["string","null"]},"amountFen":{"type":"integer","minimum":0},"version":{"type":"integer","minimum":1},"priceSnapshotFen":{"type":["integer","null"]},"servicePeriodCountSnapshot":{"type":["integer","null"]},"renewalPriceSnapshotFen":{"type":["integer","null"]},"billingRevisionSnapshot":{"type":["integer","null"]},"createdAt":{"type":"string"},"updatedAt":{"type":"string"},"paidAt":{"type":["string","null"]},"paymentRecordedAt":{"type":["string","null"]},"paymentConfirmedAt":{"type":["string","null"]},"fulfilledAt":{"type":["string","null"]},"cancelledAt":{"type":["string","null"]},"renewalPeriodStartAt":{"type":["string","null"]},"renewalPeriodEndAt":{"type":["string","null"]},"renewalForPeriodStartAt":{"type":["string","null"]},"billingAnchorSnapshotAt":{"type":["string","null"]},"kind":{"type":"string","enum":["INITIAL","RENEWAL","ONE_TIME"]},"source":{"type":"string","enum":["USER","ADMIN","SYSTEM_RENEWAL"]},"productTypeSnapshot":{"type":"string","enum":["SUBSCRIPTION","ONE_TIME"]},"paymentStatus":{"type":"string","enum":["UNPAID","PENDING_VERIFICATION","PAID","REFUND_PENDING","REFUNDED","NOT_REQUIRED"]},"fulfillmentStatus":{"type":"string","enum":["NOT_STARTED","PROCESSING","COMPLETED","FAILED","CANCELLED"]},"servicePeriodUnitSnapshot":{"type":["string","null"],"enum":["DAY","MONTH","YEAR",null]},"hidden":{"type":"boolean"},"formSchemaSnapshot":{},"formData":{}}}}}', `snapshotJson`)
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(`snapshotJson`, '$.order.id')) AS BINARY) = CAST(`orderId` AS BINARY)
      AND JSON_EXTRACT(`snapshotJson`, '$.order.version') = `version`
      AND JSON_EXTRACT(`snapshotJson`, '$.snapshotSchemaVersion') = `snapshotSchemaVersion`
    );

-- Disabled profiles that were never activated may later be restored to pending.
-- Keep all previously activated accounts, invitation tokens and business references.
UPDATE `User` AS profile
INNER JOIN `User` AS creator ON creator.`id` = profile.`createdByAdminId`
  AND creator.`role` = 'ADMIN'
SET profile.`loginEmail` = NULL, profile.`notificationEmail` = NULL
WHERE profile.`role` = 'CUSTOMER'
  AND profile.`status` IN ('PENDING_ACTIVATION', 'DISABLED')
  AND profile.`activatedAt` IS NULL AND profile.`passwordHash` IS NULL
  AND (profile.`loginEmail` IS NOT NULL OR profile.`notificationEmail` IS NOT NULL);
