-- Append-only repair: do not rewrite any of the eight preceding migrations.
-- Each DDL commits independently. Preflight DBA privileges and stop incompatible
-- writers; a partial deployment requires operator review, never automatic reset.
-- Keep both migration-six renewal guards and migration-eight source guards.
CREATE TRIGGER `Order_source_immutable_update` BEFORE UPDATE ON `Order`
FOR EACH ROW FOLLOWS `Order_no_legacy_reclassification_update`
BEGIN
  IF NOT (CAST(OLD.`source` AS BINARY) <=> CAST(NEW.`source` AS BINARY)) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ORDER_SOURCE_IMMUTABLE';
  END IF;
END;

-- REPLACE fires DELETE triggers for conflicting primary/unique keys. Protect
-- legacy rows even when they have no child references; normal UPDATE is allowed.
CREATE TRIGGER `Order_legacy_delete_guard` BEFORE DELETE ON `Order`
FOR EACH ROW FOLLOWS `Order_paid_renewal_delete`
BEGIN
  IF OLD.`source` = 'OFFLINE_MANUAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'LEGACY_ORDER_DELETE_FORBIDDEN';
  END IF;
END;
