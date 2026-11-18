-- Additive foundation only: preserve old values, links and timestamps.
-- Unknown legacy periods/forms remain NULL; never parse termLabel or copy live forms.
-- No DML, subscription recreation, payment fabrication or deletion is performed.
-- AlterTable
ALTER TABLE `Product` ADD COLUMN `servicePeriodCount` INTEGER NULL,
    ADD COLUMN `servicePeriodUnit` ENUM('DAY', 'MONTH', 'YEAR') NULL;

-- AlterTable
ALTER TABLE `Order` ADD COLUMN `cancellationReason` VARCHAR(500) NULL,
    ADD COLUMN `cancelledAt` DATETIME(3) NULL,
    ADD COLUMN `createdByUserId` VARCHAR(36) NULL,
    ADD COLUMN `formData` JSON NULL,
    ADD COLUMN `formSchemaSnapshot` JSON NULL,
    ADD COLUMN `fulfilledAt` DATETIME(3) NULL,
    ADD COLUMN `hidden` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `paymentConfirmedAt` DATETIME(3) NULL,
    ADD COLUMN `paymentRecordedAt` DATETIME(3) NULL,
    ADD COLUMN `priceSnapshotFen` INTEGER NULL,
    ADD COLUMN `productDescriptionSnapshot` TEXT NULL,
    ADD COLUMN `servicePeriodCountSnapshot` INTEGER NULL,
    ADD COLUMN `servicePeriodUnitSnapshot` ENUM('DAY', 'MONTH', 'YEAR') NULL,
    MODIFY `source` ENUM('OFFLINE_MANUAL', 'USER', 'ADMIN', 'SYSTEM_RENEWAL') NOT NULL DEFAULT 'OFFLINE_MANUAL',
    MODIFY `createdByAdminId` VARCHAR(36) NULL;

-- AlterTable
ALTER TABLE `OrderEvent` ADD COLUMN `actorType` ENUM('USER', 'ADMIN', 'SYSTEM') NOT NULL DEFAULT 'ADMIN',
    ADD COLUMN `actorUserId` VARCHAR(36) NULL,
    MODIFY `eventType` ENUM('ORDER_CREATED', 'PAYMENT_RECORDED', 'PAYMENT_CONFIRMED', 'REFUND_RECORDED', 'REFUND_CONFIRMED', 'FULFILLMENT_CHANGED', 'COMPLETED', 'NOTE', 'CANCELLED') NOT NULL,
    MODIFY `actorAdminId` VARCHAR(36) NULL;

-- AlterTable
ALTER TABLE `Subscription` ADD COLUMN `billingAnchorAt` DATETIME(3) NULL,
    ADD COLUMN `billingTimezone` VARCHAR(64) NULL,
    ADD COLUMN `currentPeriodEndAt` DATETIME(3) NULL,
    ADD COLUMN `currentPeriodStartAt` DATETIME(3) NULL,
    ADD COLUMN `earlyRenewalOrderId` VARCHAR(36) NULL,
    ADD COLUMN `earlyRenewedPeriodStartAt` DATETIME(3) NULL,
    ADD COLUMN `servicePeriodCountSnapshot` INTEGER NULL,
    ADD COLUMN `servicePeriodUnitSnapshot` ENUM('DAY', 'MONTH', 'YEAR') NULL,
    MODIFY `sourceType` ENUM('ADMIN', 'SYSTEM', 'ORDER') NOT NULL;

-- AlterTable
ALTER TABLE `AppSettings` ADD COLUMN `paymentInstructions` VARCHAR(4000) NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX `Order_source_hidden_createdAt_idx` ON `Order`(`source`, `hidden`, `createdAt`);

-- CreateIndex
CREATE UNIQUE INDEX `Subscription_earlyRenewalOrderId_key` ON `Subscription`(`earlyRenewalOrderId`);

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OrderEvent` ADD CONSTRAINT `OrderEvent_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_earlyRenewalOrderId_fkey` FOREIGN KEY (`earlyRenewalOrderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma cannot declare CHECK constraints. Keep these in versioned SQL and tests.
ALTER TABLE `Product` ADD CONSTRAINT `Product_service_period_check` CHECK (
    (`servicePeriodUnit` IS NULL AND `servicePeriodCount` IS NULL) OR
    (`servicePeriodUnit` IS NOT NULL AND `servicePeriodCount` IS NOT NULL AND `servicePeriodCount` > 0)
);

ALTER TABLE `Order` ADD CONSTRAINT `Order_service_period_check` CHECK (
    (`servicePeriodUnitSnapshot` IS NULL AND `servicePeriodCountSnapshot` IS NULL) OR
    (`servicePeriodUnitSnapshot` IS NOT NULL AND `servicePeriodCountSnapshot` IS NOT NULL AND `servicePeriodCountSnapshot` > 0)
), ADD CONSTRAINT `Order_creator_check` CHECK (
    `source` = 'OFFLINE_MANUAL' OR
    (`source` = 'ADMIN' AND `createdByAdminId` IS NOT NULL AND `createdByUserId` IS NULL) OR
    (`source` = 'USER' AND `createdByAdminId` IS NULL AND `createdByUserId` IS NOT NULL AND `createdByUserId` = `userId`) OR
    (`source` = 'SYSTEM_RENEWAL' AND `createdByAdminId` IS NULL AND `createdByUserId` IS NULL AND `kind` = 'RENEWAL' AND `subscriptionId` IS NOT NULL AND `hidden` = true)
);

ALTER TABLE `OrderEvent` ADD CONSTRAINT `OrderEvent_actor_check` CHECK (
    (`actorType` = 'ADMIN' AND `actorAdminId` IS NOT NULL AND `actorUserId` IS NULL) OR
    (`actorType` = 'USER' AND `actorUserId` IS NOT NULL AND `actorAdminId` IS NULL) OR
    (`actorType` = 'SYSTEM' AND `actorAdminId` IS NULL AND `actorUserId` IS NULL)
);

ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_order_source_check` CHECK (
    `sourceType` <> 'ORDER' OR `sourceOrderId` IS NOT NULL
), ADD CONSTRAINT `Subscription_service_period_check` CHECK (
    (`servicePeriodUnitSnapshot` IS NULL AND `servicePeriodCountSnapshot` IS NULL) OR
    (`servicePeriodUnitSnapshot` IS NOT NULL AND `servicePeriodCountSnapshot` IS NOT NULL AND `servicePeriodCountSnapshot` > 0)
), ADD CONSTRAINT `Subscription_current_period_check` CHECK (
    (`currentPeriodStartAt` IS NULL AND `currentPeriodEndAt` IS NULL) OR
    (`currentPeriodStartAt` IS NOT NULL AND `currentPeriodEndAt` IS NOT NULL AND `currentPeriodEndAt` > `currentPeriodStartAt`)
), ADD CONSTRAINT `Subscription_early_renewal_check` CHECK (
    (`earlyRenewedPeriodStartAt` IS NULL AND `earlyRenewalOrderId` IS NULL) OR
    (`earlyRenewedPeriodStartAt` IS NOT NULL AND `earlyRenewalOrderId` IS NOT NULL)
);
