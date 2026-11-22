-- Historical products keep their existing fields and start without a cover.
ALTER TABLE `Product` ADD COLUMN `coverImageKey` VARCHAR(64) NULL;
