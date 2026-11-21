ALTER TABLE `AppSettings`
  ADD COLUMN `wechatPayEnabled` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `wechatQrImageKey` VARCHAR(40) NULL,
  ADD CONSTRAINT `AppSettings_wechat_pay_requires_image`
    CHECK (`wechatPayEnabled` = FALSE OR `wechatQrImageKey` IS NOT NULL);
