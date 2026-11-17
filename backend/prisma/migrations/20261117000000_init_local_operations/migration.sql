-- CreateTable
CREATE TABLE `User` (
    `id` VARCHAR(36) NOT NULL,
    `displayName` VARCHAR(80) NOT NULL,
    `loginEmail` VARCHAR(254) NOT NULL,
    `notificationEmail` VARCHAR(254) NULL,
    `passwordHash` VARCHAR(255) NULL,
    `role` ENUM('ADMIN', 'CUSTOMER') NOT NULL DEFAULT 'CUSTOMER',
    `status` ENUM('PENDING_ACTIVATION', 'ACTIVE', 'DISABLED') NOT NULL DEFAULT 'PENDING_ACTIVATION',
    `activatedAt` DATETIME(3) NULL,
    `createdByAdminId` VARCHAR(36) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `User_loginEmail_key`(`loginEmail`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(36) NOT NULL,
    `userId` VARCHAR(36) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Session_tokenHash_key`(`tokenHash`),
    INDEX `Session_userId_idx`(`userId`),
    INDEX `Session_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `InvitationToken` (
    `id` VARCHAR(36) NOT NULL,
    `userId` VARCHAR(36) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdByAdminId` VARCHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `InvitationToken_tokenHash_key`(`tokenHash`),
    INDEX `InvitationToken_userId_idx`(`userId`),
    INDEX `InvitationToken_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Product` (
    `id` VARCHAR(36) NOT NULL,
    `slug` VARCHAR(100) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` TEXT NULL,
    `type` ENUM('SUBSCRIPTION', 'ONE_TIME') NOT NULL,
    `priceFen` INTEGER NOT NULL,
    `renewalPriceFen` INTEGER NULL,
    `termLabel` VARCHAR(40) NOT NULL,
    `targetField` ENUM('EMAIL', 'TEXT', 'NONE') NOT NULL DEFAULT 'NONE',
    `listed` BOOLEAN NOT NULL DEFAULT false,
    `purchaseEnabled` BOOLEAN NOT NULL DEFAULT false,
    `renewalEnabled` BOOLEAN NOT NULL DEFAULT false,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Product_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Order` (
    `id` VARCHAR(36) NOT NULL,
    `orderNo` VARCHAR(40) NOT NULL,
    `userId` VARCHAR(36) NOT NULL,
    `productId` VARCHAR(36) NOT NULL,
    `subscriptionId` VARCHAR(36) NULL,
    `kind` ENUM('INITIAL', 'RENEWAL', 'ONE_TIME') NOT NULL,
    `source` ENUM('OFFLINE_MANUAL') NOT NULL DEFAULT 'OFFLINE_MANUAL',
    `productNameSnapshot` VARCHAR(120) NOT NULL,
    `productTypeSnapshot` ENUM('SUBSCRIPTION', 'ONE_TIME') NOT NULL,
    `termSnapshot` VARCHAR(40) NOT NULL,
    `amountFen` INTEGER NOT NULL,
    `renewalPriceSnapshotFen` INTEGER NULL,
    `contactEmailSnapshot` VARCHAR(254) NOT NULL,
    `targetIdentifier` VARCHAR(254) NULL,
    `paymentStatus` ENUM('UNPAID', 'PENDING_VERIFICATION', 'PAID', 'REFUND_PENDING', 'REFUNDED') NOT NULL DEFAULT 'UNPAID',
    `fulfillmentStatus` ENUM('NOT_STARTED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'NOT_STARTED',
    `internalNote` TEXT NULL,
    `createdByAdminId` VARCHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Order_orderNo_key`(`orderNo`),
    INDEX `Order_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `Order_paymentStatus_createdAt_idx`(`paymentStatus`, `createdAt`),
    INDEX `Order_fulfillmentStatus_createdAt_idx`(`fulfillmentStatus`, `createdAt`),
    INDEX `Order_subscriptionId_createdAt_idx`(`subscriptionId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PaymentTransaction` (
    `id` VARCHAR(36) NOT NULL,
    `orderId` VARCHAR(36) NOT NULL,
    `kind` ENUM('PAYMENT', 'REFUND') NOT NULL,
    `channel` ENUM('WECHAT', 'ALIPAY', 'CASH', 'BANK_TRANSFER', 'OTHER') NOT NULL,
    `amountFen` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'CONFIRMED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `externalReference` VARCHAR(120) NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `confirmedAt` DATETIME(3) NULL,
    `createdByAdminId` VARCHAR(36) NOT NULL,
    `confirmedByAdminId` VARCHAR(36) NULL,
    `note` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PaymentTransaction_orderId_kind_status_idx`(`orderId`, `kind`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderEvent` (
    `id` VARCHAR(36) NOT NULL,
    `orderId` VARCHAR(36) NOT NULL,
    `eventType` ENUM('ORDER_CREATED', 'PAYMENT_RECORDED', 'PAYMENT_CONFIRMED', 'REFUND_RECORDED', 'REFUND_CONFIRMED', 'FULFILLMENT_CHANGED', 'COMPLETED', 'NOTE') NOT NULL,
    `actorAdminId` VARCHAR(36) NOT NULL,
    `fromStateJson` JSON NULL,
    `toStateJson` JSON NULL,
    `note` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderEvent_orderId_createdAt_idx`(`orderId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Subscription` (
    `id` VARCHAR(36) NOT NULL,
    `userId` VARCHAR(36) NOT NULL,
    `productId` VARCHAR(36) NOT NULL,
    `sourceOrderId` VARCHAR(36) NULL,
    `sourceType` ENUM('ORDER', 'MANUAL_GRANT', 'HISTORICAL_IMPORT') NOT NULL,
    `targetIdentifier` VARCHAR(254) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `renewalPriceFen` INTEGER NOT NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'TERMINATED') NOT NULL DEFAULT 'ACTIVE',
    `createdByAdminId` VARCHAR(36) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Subscription_sourceOrderId_key`(`sourceOrderId`),
    INDEX `Subscription_userId_status_idx`(`userId`, `status`),
    INDEX `Subscription_expiresAt_status_idx`(`expiresAt`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SubscriptionEvent` (
    `id` VARCHAR(36) NOT NULL,
    `subscriptionId` VARCHAR(36) NOT NULL,
    `orderId` VARCHAR(36) NULL,
    `eventType` ENUM('CREATED', 'ACTIVATED', 'RENEWED', 'EXPIRY_ADJUSTED', 'MANUAL_GRANT', 'HISTORICAL_IMPORT', 'SUSPENDED', 'RESUMED', 'TERMINATED', 'NOTE') NOT NULL,
    `oldStartedAt` DATETIME(3) NULL,
    `newStartedAt` DATETIME(3) NULL,
    `oldExpiresAt` DATETIME(3) NULL,
    `newExpiresAt` DATETIME(3) NULL,
    `actorAdminId` VARCHAR(36) NOT NULL,
    `reason` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SubscriptionEvent_subscriptionId_createdAt_idx`(`subscriptionId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AdminAuditLog` (
    `id` VARCHAR(36) NOT NULL,
    `actorAdminId` VARCHAR(36) NOT NULL,
    `action` VARCHAR(80) NOT NULL,
    `entityType` VARCHAR(40) NOT NULL,
    `entityId` VARCHAR(40) NOT NULL,
    `beforeJson` JSON NULL,
    `afterJson` JSON NULL,
    `reason` VARCHAR(500) NULL,
    `requestId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AdminAuditLog_actorAdminId_createdAt_idx`(`actorAdminId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AppSettings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `storeName` VARCHAR(80) NOT NULL,
    `ownerEmail` VARCHAR(254) NOT NULL,
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_createdByAdminId_fkey` FOREIGN KEY (`createdByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Session` ADD CONSTRAINT `Session_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `InvitationToken` ADD CONSTRAINT `InvitationToken_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `InvitationToken` ADD CONSTRAINT `InvitationToken_createdByAdminId_fkey` FOREIGN KEY (`createdByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_createdByAdminId_fkey` FOREIGN KEY (`createdByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `PaymentTransaction` ADD CONSTRAINT `PaymentTransaction_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `PaymentTransaction` ADD CONSTRAINT `PaymentTransaction_createdByAdminId_fkey` FOREIGN KEY (`createdByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `PaymentTransaction` ADD CONSTRAINT `PaymentTransaction_confirmedByAdminId_fkey` FOREIGN KEY (`confirmedByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OrderEvent` ADD CONSTRAINT `OrderEvent_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `OrderEvent` ADD CONSTRAINT `OrderEvent_actorAdminId_fkey` FOREIGN KEY (`actorAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_sourceOrderId_fkey` FOREIGN KEY (`sourceOrderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_createdByAdminId_fkey` FOREIGN KEY (`createdByAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `SubscriptionEvent` ADD CONSTRAINT `SubscriptionEvent_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `Subscription`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `SubscriptionEvent` ADD CONSTRAINT `SubscriptionEvent_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `SubscriptionEvent` ADD CONSTRAINT `SubscriptionEvent_actorAdminId_fkey` FOREIGN KEY (`actorAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `AdminAuditLog` ADD CONSTRAINT `AdminAuditLog_actorAdminId_fkey` FOREIGN KEY (`actorAdminId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The documented settings singleton must use id = 1. Prisma does not model
-- CHECK constraints, so keep this constraint in the versioned SQL migration.
ALTER TABLE `AppSettings` ADD CONSTRAINT `AppSettings_singleton_check` CHECK (`id` = 1);
