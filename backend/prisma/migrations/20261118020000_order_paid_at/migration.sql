-- Separate actual payment occurrence from the deprecated legacy entry timestamp.
-- Keep all six preceding migrations unchanged. No backfill from recorded/created/
-- updated/confirmed times, nor from an unverified historical transaction.
-- One ALTER keeps the table change atomic: existing SYSTEM_RENEWAL rows without
-- a known paidAt make deployment fail; never manufacture their actual payment time.
ALTER TABLE `Order`
    ADD COLUMN `paidAt` DATETIME(3) NULL,
    DROP CHECK `Order_system_renewal_final_check`,
    ADD CONSTRAINT `Order_system_renewal_final_check` CHECK (
      `source` <> 'SYSTEM_RENEWAL' OR
      (`kind` = 'RENEWAL' AND `hidden` = true AND `subscriptionId` IS NOT NULL
       AND `paymentStatus` = 'PAID' AND `fulfillmentStatus` = 'COMPLETED'
       AND `paidAt` IS NOT NULL AND `paymentConfirmedAt` IS NOT NULL AND `fulfilledAt` IS NOT NULL
       AND `cancelledAt` IS NULL
       AND `paidAt` <= `paymentConfirmedAt` AND `paymentConfirmedAt` <= `fulfilledAt`)
    ),
    ADD CONSTRAINT `Order_payment_timeline_check` CHECK (
      `source` = 'OFFLINE_MANUAL' OR
      ((`paidAt` IS NULL OR `paymentConfirmedAt` IS NULL OR `paidAt` <= `paymentConfirmedAt`)
       AND (`paymentConfirmedAt` IS NULL OR `fulfilledAt` IS NULL OR `paymentConfirmedAt` <= `fulfilledAt`)
       AND (`paidAt` IS NULL OR `fulfilledAt` IS NULL OR `paidAt` <= `fulfilledAt`))
    );
