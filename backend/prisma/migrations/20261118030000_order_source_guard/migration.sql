-- Preserve all seven preceding migration checksums and every historical row.
-- Install guards before removing the default; a multi-statement DDL failure
-- still requires operator review, never an automatic reset/resolve/retry.
-- Requires the same DBA-approved trigger DDL privileges as migration six.
CREATE TRIGGER `Order_new_source_insert` BEFORE INSERT ON `Order`
FOR EACH ROW
BEGIN
  IF NEW.`source` IS NULL OR NEW.`source` NOT IN ('USER','ADMIN','SYSTEM_RENEWAL') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_SOURCE_REQUIRED';
  END IF;
END;

-- An UPDATE/upsert must not reclassify a new order into the legacy CHECK exemption.
-- Existing OFFLINE_MANUAL rows retain their compatibility behavior.
CREATE TRIGGER `Order_no_legacy_reclassification_update` BEFORE UPDATE ON `Order`
FOR EACH ROW
BEGIN
  IF OLD.`source` <> 'OFFLINE_MANUAL' AND NEW.`source` = 'OFFLINE_MANUAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_LEGACY_SOURCE_FORBIDDEN';
  END IF;
END;

ALTER TABLE `Order` ALTER COLUMN `source` DROP DEFAULT;
