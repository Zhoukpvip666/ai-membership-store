-- Review follow-up: do not edit the five preceding migrations or infer old periods.
-- Creating the triggers with binlog enabled requires DBA-approved elevated migration privileges.
-- All added columns are NULL on history. No data UPDATE/DELETE or payment fabrication.
-- Timezone whitelist: Node.js 24.13.0, ICU 77.1; canonical IANA zones plus UTC aliases.
-- Future inputs normalize IANA aliases before persistence. No MySQL timezone-table dependency.
ALTER TABLE `Subscription`
    ADD COLUMN `billingRevision` INTEGER NULL,
    ADD COLUMN `earlyRenewalUsed` BOOLEAN NULL;

ALTER TABLE `Order`
    ADD COLUMN `renewalPeriodStartAt` DATETIME(3) NULL,
    ADD COLUMN `renewalPeriodEndAt` DATETIME(3) NULL,
    ADD COLUMN `renewalForPeriodStartAt` DATETIME(3) NULL,
    ADD COLUMN `billingAnchorSnapshotAt` DATETIME(3) NULL,
    ADD COLUMN `billingTimezoneSnapshot` VARCHAR(64) NULL,
    ADD COLUMN `billingRevisionSnapshot` INTEGER NULL,
    ADD COLUMN `renewalRequestKeyHash` VARCHAR(64) NULL,
    ADD COLUMN `renewalRequestHash` VARCHAR(64) NULL;

-- Keep the legacy exemption. New ordinary orders cannot impersonate hidden renewals.
ALTER TABLE `Order` DROP CHECK `Order_creator_check`,
    ADD CONSTRAINT `Order_creator_check` CHECK (
      `source` = 'OFFLINE_MANUAL' OR
      (`source` IN ('USER','ADMIN') AND `kind` IN ('INITIAL','ONE_TIME')
       AND `hidden` = false AND `subscriptionId` IS NULL
       AND ((`kind` = 'INITIAL' AND `productTypeSnapshot` = 'SUBSCRIPTION')
         OR (`kind` = 'ONE_TIME' AND `productTypeSnapshot` = 'ONE_TIME'))
       AND ((`source` = 'USER' AND `createdByUserId` IS NOT NULL AND `createdByUserId` = `userId` AND `createdByAdminId` IS NULL)
         OR (`source` = 'ADMIN' AND `createdByAdminId` IS NOT NULL AND `createdByUserId` IS NULL))) OR
      (`source` = 'SYSTEM_RENEWAL' AND `kind` = 'RENEWAL' AND `hidden` = true
       AND `productTypeSnapshot` = 'SUBSCRIPTION' AND `subscriptionId` IS NOT NULL
       AND `createdByAdminId` IS NULL AND `createdByUserId` IS NULL)
    ),
    ADD CONSTRAINT `Order_new_subscription_period_check` CHECK (
      `source` = 'OFFLINE_MANUAL' OR `productTypeSnapshot` <> 'SUBSCRIPTION' OR
      (`servicePeriodUnitSnapshot` IS NOT NULL AND `servicePeriodCountSnapshot` IS NOT NULL AND `servicePeriodCountSnapshot` > 0)
    ),
    ADD CONSTRAINT `Order_renewal_snapshot_check` CHECK (
      `source` = 'OFFLINE_MANUAL' OR
      (`source` <> 'SYSTEM_RENEWAL' AND `renewalPeriodStartAt` IS NULL AND `renewalPeriodEndAt` IS NULL AND `renewalForPeriodStartAt` IS NULL AND `billingAnchorSnapshotAt` IS NULL AND `billingTimezoneSnapshot` IS NULL AND `billingRevisionSnapshot` IS NULL AND `renewalRequestKeyHash` IS NULL AND `renewalRequestHash` IS NULL) OR
      (`source` = 'SYSTEM_RENEWAL' AND `renewalPeriodStartAt` IS NOT NULL AND `renewalPeriodEndAt` IS NOT NULL AND `renewalForPeriodStartAt` IS NOT NULL AND `billingAnchorSnapshotAt` IS NOT NULL AND `billingTimezoneSnapshot` IS NOT NULL AND `billingRevisionSnapshot` IS NOT NULL AND `renewalRequestKeyHash` IS NOT NULL AND `renewalRequestHash` IS NOT NULL
       AND REGEXP_LIKE(`renewalRequestKeyHash`, '^[a-f0-9]{64}$', 'c') AND REGEXP_LIKE(`renewalRequestHash`, '^[a-f0-9]{64}$', 'c')
       AND `billingRevisionSnapshot` > 0
       AND `renewalForPeriodStartAt` < `renewalPeriodStartAt`
       AND `renewalPeriodEndAt` > `renewalPeriodStartAt`
       AND CAST(`billingTimezoneSnapshot` AS BINARY) IN ('Africa/Abidjan', 'Africa/Accra', 'Africa/Addis_Ababa', 'Africa/Algiers', 'Africa/Asmera', 'Africa/Bamako', 'Africa/Bangui', 'Africa/Banjul', 'Africa/Bissau', 'Africa/Blantyre', 'Africa/Brazzaville', 'Africa/Bujumbura', 'Africa/Cairo', 'Africa/Casablanca', 'Africa/Ceuta', 'Africa/Conakry', 'Africa/Dakar', 'Africa/Dar_es_Salaam', 'Africa/Djibouti', 'Africa/Douala', 'Africa/El_Aaiun', 'Africa/Freetown', 'Africa/Gaborone', 'Africa/Harare', 'Africa/Johannesburg', 'Africa/Juba', 'Africa/Kampala', 'Africa/Khartoum', 'Africa/Kigali', 'Africa/Kinshasa', 'Africa/Lagos', 'Africa/Libreville', 'Africa/Lome', 'Africa/Luanda', 'Africa/Lubumbashi', 'Africa/Lusaka', 'Africa/Malabo', 'Africa/Maputo', 'Africa/Maseru', 'Africa/Mbabane', 'Africa/Mogadishu', 'Africa/Monrovia', 'Africa/Nairobi', 'Africa/Ndjamena', 'Africa/Niamey', 'Africa/Nouakchott', 'Africa/Ouagadougou', 'Africa/Porto-Novo', 'Africa/Sao_Tome', 'Africa/Tripoli', 'Africa/Tunis', 'Africa/Windhoek', 'America/Adak', 'America/Anchorage', 'America/Anguilla', 'America/Antigua', 'America/Araguaina', 'America/Argentina/La_Rioja', 'America/Argentina/Rio_Gallegos', 'America/Argentina/Salta', 'America/Argentina/San_Juan', 'America/Argentina/San_Luis', 'America/Argentina/Tucuman', 'America/Argentina/Ushuaia', 'America/Aruba', 'America/Asuncion', 'America/Bahia', 'America/Bahia_Banderas', 'America/Barbados', 'America/Belem', 'America/Belize', 'America/Blanc-Sablon', 'America/Boa_Vista', 'America/Bogota', 'America/Boise', 'America/Buenos_Aires', 'America/Cambridge_Bay', 'America/Campo_Grande', 'America/Cancun', 'America/Caracas', 'America/Catamarca', 'America/Cayenne', 'America/Cayman', 'America/Chicago', 'America/Chihuahua', 'America/Ciudad_Juarez', 'America/Coral_Harbour', 'America/Cordoba', 'America/Costa_Rica', 'America/Coyhaique', 'America/Creston', 'America/Cuiaba', 'America/Curacao', 'America/Danmarkshavn', 'America/Dawson', 'America/Dawson_Creek', 'America/Denver', 'America/Detroit', 'America/Dominica', 'America/Edmonton', 'America/Eirunepe', 'America/El_Salvador', 'America/Fort_Nelson', 'America/Fortaleza', 'America/Glace_Bay', 'America/Godthab', 'America/Goose_Bay', 'America/Grand_Turk', 'America/Grenada', 'America/Guadeloupe', 'America/Guatemala', 'America/Guayaquil', 'America/Guyana', 'America/Halifax', 'America/Havana', 'America/Hermosillo', 'America/Indiana/Knox', 'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Tell_City', 'America/Indiana/Vevay', 'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Indianapolis', 'America/Inuvik', 'America/Iqaluit', 'America/Jamaica', 'America/Jujuy', 'America/Juneau', 'America/Kentucky/Monticello', 'America/Kralendijk', 'America/La_Paz', 'America/Lima', 'America/Los_Angeles', 'America/Louisville', 'America/Lower_Princes', 'America/Maceio', 'America/Managua', 'America/Manaus', 'America/Marigot', 'America/Martinique', 'America/Matamoros', 'America/Mazatlan', 'America/Mendoza', 'America/Menominee', 'America/Merida', 'America/Metlakatla', 'America/Mexico_City', 'America/Miquelon', 'America/Moncton', 'America/Monterrey', 'America/Montevideo', 'America/Montserrat', 'America/Nassau', 'America/New_York', 'America/Nome', 'America/Noronha', 'America/North_Dakota/Beulah', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem', 'America/Ojinaga', 'America/Panama', 'America/Paramaribo', 'America/Phoenix', 'America/Port-au-Prince', 'America/Port_of_Spain', 'America/Porto_Velho', 'America/Puerto_Rico', 'America/Punta_Arenas', 'America/Rankin_Inlet', 'America/Recife', 'America/Regina', 'America/Resolute', 'America/Rio_Branco', 'America/Santarem', 'America/Santiago', 'America/Santo_Domingo', 'America/Sao_Paulo', 'America/Scoresbysund', 'America/Sitka', 'America/St_Barthelemy', 'America/St_Johns', 'America/St_Kitts', 'America/St_Lucia', 'America/St_Thomas', 'America/St_Vincent', 'America/Swift_Current', 'America/Tegucigalpa', 'America/Thule', 'America/Tijuana', 'America/Toronto', 'America/Tortola', 'America/Vancouver', 'America/Whitehorse', 'America/Winnipeg', 'America/Yakutat', 'Antarctica/Casey', 'Antarctica/Davis', 'Antarctica/DumontDUrville', 'Antarctica/Macquarie', 'Antarctica/Mawson', 'Antarctica/McMurdo', 'Antarctica/Palmer', 'Antarctica/Rothera', 'Antarctica/Syowa', 'Antarctica/Troll', 'Antarctica/Vostok', 'Arctic/Longyearbyen', 'Asia/Aden', 'Asia/Almaty', 'Asia/Amman', 'Asia/Anadyr', 'Asia/Aqtau', 'Asia/Aqtobe', 'Asia/Ashgabat', 'Asia/Atyrau', 'Asia/Baghdad', 'Asia/Bahrain', 'Asia/Baku', 'Asia/Bangkok', 'Asia/Barnaul', 'Asia/Beirut', 'Asia/Bishkek', 'Asia/Brunei', 'Asia/Calcutta', 'Asia/Chita', 'Asia/Colombo', 'Asia/Damascus', 'Asia/Dhaka', 'Asia/Dili', 'Asia/Dubai', 'Asia/Dushanbe', 'Asia/Famagusta', 'Asia/Gaza', 'Asia/Hebron', 'Asia/Hong_Kong', 'Asia/Hovd', 'Asia/Irkutsk', 'Asia/Jakarta', 'Asia/Jayapura', 'Asia/Jerusalem', 'Asia/Kabul', 'Asia/Kamchatka', 'Asia/Karachi', 'Asia/Katmandu', 'Asia/Khandyga', 'Asia/Krasnoyarsk', 'Asia/Kuala_Lumpur', 'Asia/Kuching', 'Asia/Kuwait', 'Asia/Macau', 'Asia/Magadan', 'Asia/Makassar', 'Asia/Manila', 'Asia/Muscat', 'Asia/Nicosia', 'Asia/Novokuznetsk', 'Asia/Novosibirsk', 'Asia/Omsk', 'Asia/Oral', 'Asia/Phnom_Penh', 'Asia/Pontianak', 'Asia/Pyongyang', 'Asia/Qatar', 'Asia/Qostanay', 'Asia/Qyzylorda', 'Asia/Rangoon', 'Asia/Riyadh', 'Asia/Saigon', 'Asia/Sakhalin', 'Asia/Samarkand', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Srednekolymsk', 'Asia/Taipei', 'Asia/Tashkent', 'Asia/Tbilisi', 'Asia/Tehran', 'Asia/Thimphu', 'Asia/Tokyo', 'Asia/Tomsk', 'Asia/Ulaanbaatar', 'Asia/Urumqi', 'Asia/Ust-Nera', 'Asia/Vientiane', 'Asia/Vladivostok', 'Asia/Yakutsk', 'Asia/Yekaterinburg', 'Asia/Yerevan', 'Atlantic/Azores', 'Atlantic/Bermuda', 'Atlantic/Canary', 'Atlantic/Cape_Verde', 'Atlantic/Faeroe', 'Atlantic/Madeira', 'Atlantic/Reykjavik', 'Atlantic/South_Georgia', 'Atlantic/St_Helena', 'Atlantic/Stanley', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Broken_Hill', 'Australia/Darwin', 'Australia/Eucla', 'Australia/Hobart', 'Australia/Lindeman', 'Australia/Lord_Howe', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney', 'Etc/GMT', 'Etc/GMT+0', 'Etc/GMT+1', 'Etc/GMT+10', 'Etc/GMT+11', 'Etc/GMT+12', 'Etc/GMT+2', 'Etc/GMT+3', 'Etc/GMT+4', 'Etc/GMT+5', 'Etc/GMT+6', 'Etc/GMT+7', 'Etc/GMT+8', 'Etc/GMT+9', 'Etc/GMT-0', 'Etc/GMT-1', 'Etc/GMT-10', 'Etc/GMT-11', 'Etc/GMT-12', 'Etc/GMT-13', 'Etc/GMT-14', 'Etc/GMT-2', 'Etc/GMT-3', 'Etc/GMT-4', 'Etc/GMT-5', 'Etc/GMT-6', 'Etc/GMT-7', 'Etc/GMT-8', 'Etc/GMT-9', 'Etc/UTC', 'Europe/Amsterdam', 'Europe/Andorra', 'Europe/Astrakhan', 'Europe/Athens', 'Europe/Belgrade', 'Europe/Berlin', 'Europe/Bratislava', 'Europe/Brussels', 'Europe/Bucharest', 'Europe/Budapest', 'Europe/Busingen', 'Europe/Chisinau', 'Europe/Copenhagen', 'Europe/Dublin', 'Europe/Gibraltar', 'Europe/Guernsey', 'Europe/Helsinki', 'Europe/Isle_of_Man', 'Europe/Istanbul', 'Europe/Jersey', 'Europe/Kaliningrad', 'Europe/Kiev', 'Europe/Kirov', 'Europe/Lisbon', 'Europe/Ljubljana', 'Europe/London', 'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Malta', 'Europe/Mariehamn', 'Europe/Minsk', 'Europe/Monaco', 'Europe/Moscow', 'Europe/Oslo', 'Europe/Paris', 'Europe/Podgorica', 'Europe/Prague', 'Europe/Riga', 'Europe/Rome', 'Europe/Samara', 'Europe/San_Marino', 'Europe/Sarajevo', 'Europe/Saratov', 'Europe/Simferopol', 'Europe/Skopje', 'Europe/Sofia', 'Europe/Stockholm', 'Europe/Tallinn', 'Europe/Tirane', 'Europe/Ulyanovsk', 'Europe/Vaduz', 'Europe/Vatican', 'Europe/Vienna', 'Europe/Vilnius', 'Europe/Volgograd', 'Europe/Warsaw', 'Europe/Zagreb', 'Europe/Zurich', 'GMT', 'Indian/Antananarivo', 'Indian/Chagos', 'Indian/Christmas', 'Indian/Cocos', 'Indian/Comoro', 'Indian/Kerguelen', 'Indian/Mahe', 'Indian/Maldives', 'Indian/Mauritius', 'Indian/Mayotte', 'Indian/Reunion', 'Pacific/Apia', 'Pacific/Auckland', 'Pacific/Bougainville', 'Pacific/Chatham', 'Pacific/Easter', 'Pacific/Efate', 'Pacific/Enderbury', 'Pacific/Fakaofo', 'Pacific/Fiji', 'Pacific/Funafuti', 'Pacific/Galapagos', 'Pacific/Gambier', 'Pacific/Guadalcanal', 'Pacific/Guam', 'Pacific/Honolulu', 'Pacific/Kiritimati', 'Pacific/Kosrae', 'Pacific/Kwajalein', 'Pacific/Majuro', 'Pacific/Marquesas', 'Pacific/Midway', 'Pacific/Nauru', 'Pacific/Niue', 'Pacific/Norfolk', 'Pacific/Noumea', 'Pacific/Pago_Pago', 'Pacific/Palau', 'Pacific/Pitcairn', 'Pacific/Ponape', 'Pacific/Port_Moresby', 'Pacific/Rarotonga', 'Pacific/Saipan', 'Pacific/Tahiti', 'Pacific/Tarawa', 'Pacific/Tongatapu', 'Pacific/Truk', 'Pacific/Wake', 'Pacific/Wallis', 'UTC'))
    ),
    -- System renewals are inserted only after verified payment, already fulfilled.
    -- paymentRecordedAt is the existing order-level payment timestamp; actual
    -- external occurrence remains PaymentTransaction.occurredAt. Guard NULLs
    -- explicitly: MySQL CHECK accepts UNKNOWN as well as TRUE.
    ADD CONSTRAINT `Order_system_renewal_final_check` CHECK (
      `source` <> 'SYSTEM_RENEWAL' OR
      (`kind` = 'RENEWAL' AND `hidden` = true AND `subscriptionId` IS NOT NULL
       AND `paymentStatus` = 'PAID' AND `fulfillmentStatus` = 'COMPLETED'
       AND `paymentRecordedAt` IS NOT NULL AND `paymentConfirmedAt` IS NOT NULL AND `fulfilledAt` IS NOT NULL
       AND `cancelledAt` IS NULL
       AND `paymentRecordedAt` <= `paymentConfirmedAt` AND `paymentConfirmedAt` <= `fulfilledAt`)
    );

ALTER TABLE `Subscription` ADD CONSTRAINT `Subscription_order_complete_check` CHECK (
    `sourceType` <> 'ORDER' OR
    (`productTypeSnapshot` = 'SUBSCRIPTION' AND `sourceOrderId` IS NOT NULL
     AND `servicePeriodUnitSnapshot` IS NOT NULL AND `servicePeriodCountSnapshot` IS NOT NULL AND `servicePeriodCountSnapshot` > 0
     AND `billingAnchorAt` IS NOT NULL AND `billingTimezone` IS NOT NULL
     AND CAST(`billingTimezone` AS BINARY) IN ('Africa/Abidjan', 'Africa/Accra', 'Africa/Addis_Ababa', 'Africa/Algiers', 'Africa/Asmera', 'Africa/Bamako', 'Africa/Bangui', 'Africa/Banjul', 'Africa/Bissau', 'Africa/Blantyre', 'Africa/Brazzaville', 'Africa/Bujumbura', 'Africa/Cairo', 'Africa/Casablanca', 'Africa/Ceuta', 'Africa/Conakry', 'Africa/Dakar', 'Africa/Dar_es_Salaam', 'Africa/Djibouti', 'Africa/Douala', 'Africa/El_Aaiun', 'Africa/Freetown', 'Africa/Gaborone', 'Africa/Harare', 'Africa/Johannesburg', 'Africa/Juba', 'Africa/Kampala', 'Africa/Khartoum', 'Africa/Kigali', 'Africa/Kinshasa', 'Africa/Lagos', 'Africa/Libreville', 'Africa/Lome', 'Africa/Luanda', 'Africa/Lubumbashi', 'Africa/Lusaka', 'Africa/Malabo', 'Africa/Maputo', 'Africa/Maseru', 'Africa/Mbabane', 'Africa/Mogadishu', 'Africa/Monrovia', 'Africa/Nairobi', 'Africa/Ndjamena', 'Africa/Niamey', 'Africa/Nouakchott', 'Africa/Ouagadougou', 'Africa/Porto-Novo', 'Africa/Sao_Tome', 'Africa/Tripoli', 'Africa/Tunis', 'Africa/Windhoek', 'America/Adak', 'America/Anchorage', 'America/Anguilla', 'America/Antigua', 'America/Araguaina', 'America/Argentina/La_Rioja', 'America/Argentina/Rio_Gallegos', 'America/Argentina/Salta', 'America/Argentina/San_Juan', 'America/Argentina/San_Luis', 'America/Argentina/Tucuman', 'America/Argentina/Ushuaia', 'America/Aruba', 'America/Asuncion', 'America/Bahia', 'America/Bahia_Banderas', 'America/Barbados', 'America/Belem', 'America/Belize', 'America/Blanc-Sablon', 'America/Boa_Vista', 'America/Bogota', 'America/Boise', 'America/Buenos_Aires', 'America/Cambridge_Bay', 'America/Campo_Grande', 'America/Cancun', 'America/Caracas', 'America/Catamarca', 'America/Cayenne', 'America/Cayman', 'America/Chicago', 'America/Chihuahua', 'America/Ciudad_Juarez', 'America/Coral_Harbour', 'America/Cordoba', 'America/Costa_Rica', 'America/Coyhaique', 'America/Creston', 'America/Cuiaba', 'America/Curacao', 'America/Danmarkshavn', 'America/Dawson', 'America/Dawson_Creek', 'America/Denver', 'America/Detroit', 'America/Dominica', 'America/Edmonton', 'America/Eirunepe', 'America/El_Salvador', 'America/Fort_Nelson', 'America/Fortaleza', 'America/Glace_Bay', 'America/Godthab', 'America/Goose_Bay', 'America/Grand_Turk', 'America/Grenada', 'America/Guadeloupe', 'America/Guatemala', 'America/Guayaquil', 'America/Guyana', 'America/Halifax', 'America/Havana', 'America/Hermosillo', 'America/Indiana/Knox', 'America/Indiana/Marengo', 'America/Indiana/Petersburg', 'America/Indiana/Tell_City', 'America/Indiana/Vevay', 'America/Indiana/Vincennes', 'America/Indiana/Winamac', 'America/Indianapolis', 'America/Inuvik', 'America/Iqaluit', 'America/Jamaica', 'America/Jujuy', 'America/Juneau', 'America/Kentucky/Monticello', 'America/Kralendijk', 'America/La_Paz', 'America/Lima', 'America/Los_Angeles', 'America/Louisville', 'America/Lower_Princes', 'America/Maceio', 'America/Managua', 'America/Manaus', 'America/Marigot', 'America/Martinique', 'America/Matamoros', 'America/Mazatlan', 'America/Mendoza', 'America/Menominee', 'America/Merida', 'America/Metlakatla', 'America/Mexico_City', 'America/Miquelon', 'America/Moncton', 'America/Monterrey', 'America/Montevideo', 'America/Montserrat', 'America/Nassau', 'America/New_York', 'America/Nome', 'America/Noronha', 'America/North_Dakota/Beulah', 'America/North_Dakota/Center', 'America/North_Dakota/New_Salem', 'America/Ojinaga', 'America/Panama', 'America/Paramaribo', 'America/Phoenix', 'America/Port-au-Prince', 'America/Port_of_Spain', 'America/Porto_Velho', 'America/Puerto_Rico', 'America/Punta_Arenas', 'America/Rankin_Inlet', 'America/Recife', 'America/Regina', 'America/Resolute', 'America/Rio_Branco', 'America/Santarem', 'America/Santiago', 'America/Santo_Domingo', 'America/Sao_Paulo', 'America/Scoresbysund', 'America/Sitka', 'America/St_Barthelemy', 'America/St_Johns', 'America/St_Kitts', 'America/St_Lucia', 'America/St_Thomas', 'America/St_Vincent', 'America/Swift_Current', 'America/Tegucigalpa', 'America/Thule', 'America/Tijuana', 'America/Toronto', 'America/Tortola', 'America/Vancouver', 'America/Whitehorse', 'America/Winnipeg', 'America/Yakutat', 'Antarctica/Casey', 'Antarctica/Davis', 'Antarctica/DumontDUrville', 'Antarctica/Macquarie', 'Antarctica/Mawson', 'Antarctica/McMurdo', 'Antarctica/Palmer', 'Antarctica/Rothera', 'Antarctica/Syowa', 'Antarctica/Troll', 'Antarctica/Vostok', 'Arctic/Longyearbyen', 'Asia/Aden', 'Asia/Almaty', 'Asia/Amman', 'Asia/Anadyr', 'Asia/Aqtau', 'Asia/Aqtobe', 'Asia/Ashgabat', 'Asia/Atyrau', 'Asia/Baghdad', 'Asia/Bahrain', 'Asia/Baku', 'Asia/Bangkok', 'Asia/Barnaul', 'Asia/Beirut', 'Asia/Bishkek', 'Asia/Brunei', 'Asia/Calcutta', 'Asia/Chita', 'Asia/Colombo', 'Asia/Damascus', 'Asia/Dhaka', 'Asia/Dili', 'Asia/Dubai', 'Asia/Dushanbe', 'Asia/Famagusta', 'Asia/Gaza', 'Asia/Hebron', 'Asia/Hong_Kong', 'Asia/Hovd', 'Asia/Irkutsk', 'Asia/Jakarta', 'Asia/Jayapura', 'Asia/Jerusalem', 'Asia/Kabul', 'Asia/Kamchatka', 'Asia/Karachi', 'Asia/Katmandu', 'Asia/Khandyga', 'Asia/Krasnoyarsk', 'Asia/Kuala_Lumpur', 'Asia/Kuching', 'Asia/Kuwait', 'Asia/Macau', 'Asia/Magadan', 'Asia/Makassar', 'Asia/Manila', 'Asia/Muscat', 'Asia/Nicosia', 'Asia/Novokuznetsk', 'Asia/Novosibirsk', 'Asia/Omsk', 'Asia/Oral', 'Asia/Phnom_Penh', 'Asia/Pontianak', 'Asia/Pyongyang', 'Asia/Qatar', 'Asia/Qostanay', 'Asia/Qyzylorda', 'Asia/Rangoon', 'Asia/Riyadh', 'Asia/Saigon', 'Asia/Sakhalin', 'Asia/Samarkand', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Srednekolymsk', 'Asia/Taipei', 'Asia/Tashkent', 'Asia/Tbilisi', 'Asia/Tehran', 'Asia/Thimphu', 'Asia/Tokyo', 'Asia/Tomsk', 'Asia/Ulaanbaatar', 'Asia/Urumqi', 'Asia/Ust-Nera', 'Asia/Vientiane', 'Asia/Vladivostok', 'Asia/Yakutsk', 'Asia/Yekaterinburg', 'Asia/Yerevan', 'Atlantic/Azores', 'Atlantic/Bermuda', 'Atlantic/Canary', 'Atlantic/Cape_Verde', 'Atlantic/Faeroe', 'Atlantic/Madeira', 'Atlantic/Reykjavik', 'Atlantic/South_Georgia', 'Atlantic/St_Helena', 'Atlantic/Stanley', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Broken_Hill', 'Australia/Darwin', 'Australia/Eucla', 'Australia/Hobart', 'Australia/Lindeman', 'Australia/Lord_Howe', 'Australia/Melbourne', 'Australia/Perth', 'Australia/Sydney', 'Etc/GMT', 'Etc/GMT+0', 'Etc/GMT+1', 'Etc/GMT+10', 'Etc/GMT+11', 'Etc/GMT+12', 'Etc/GMT+2', 'Etc/GMT+3', 'Etc/GMT+4', 'Etc/GMT+5', 'Etc/GMT+6', 'Etc/GMT+7', 'Etc/GMT+8', 'Etc/GMT+9', 'Etc/GMT-0', 'Etc/GMT-1', 'Etc/GMT-10', 'Etc/GMT-11', 'Etc/GMT-12', 'Etc/GMT-13', 'Etc/GMT-14', 'Etc/GMT-2', 'Etc/GMT-3', 'Etc/GMT-4', 'Etc/GMT-5', 'Etc/GMT-6', 'Etc/GMT-7', 'Etc/GMT-8', 'Etc/GMT-9', 'Etc/UTC', 'Europe/Amsterdam', 'Europe/Andorra', 'Europe/Astrakhan', 'Europe/Athens', 'Europe/Belgrade', 'Europe/Berlin', 'Europe/Bratislava', 'Europe/Brussels', 'Europe/Bucharest', 'Europe/Budapest', 'Europe/Busingen', 'Europe/Chisinau', 'Europe/Copenhagen', 'Europe/Dublin', 'Europe/Gibraltar', 'Europe/Guernsey', 'Europe/Helsinki', 'Europe/Isle_of_Man', 'Europe/Istanbul', 'Europe/Jersey', 'Europe/Kaliningrad', 'Europe/Kiev', 'Europe/Kirov', 'Europe/Lisbon', 'Europe/Ljubljana', 'Europe/London', 'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Malta', 'Europe/Mariehamn', 'Europe/Minsk', 'Europe/Monaco', 'Europe/Moscow', 'Europe/Oslo', 'Europe/Paris', 'Europe/Podgorica', 'Europe/Prague', 'Europe/Riga', 'Europe/Rome', 'Europe/Samara', 'Europe/San_Marino', 'Europe/Sarajevo', 'Europe/Saratov', 'Europe/Simferopol', 'Europe/Skopje', 'Europe/Sofia', 'Europe/Stockholm', 'Europe/Tallinn', 'Europe/Tirane', 'Europe/Ulyanovsk', 'Europe/Vaduz', 'Europe/Vatican', 'Europe/Vienna', 'Europe/Vilnius', 'Europe/Volgograd', 'Europe/Warsaw', 'Europe/Zagreb', 'Europe/Zurich', 'GMT', 'Indian/Antananarivo', 'Indian/Chagos', 'Indian/Christmas', 'Indian/Cocos', 'Indian/Comoro', 'Indian/Kerguelen', 'Indian/Mahe', 'Indian/Maldives', 'Indian/Mauritius', 'Indian/Mayotte', 'Indian/Reunion', 'Pacific/Apia', 'Pacific/Auckland', 'Pacific/Bougainville', 'Pacific/Chatham', 'Pacific/Easter', 'Pacific/Efate', 'Pacific/Enderbury', 'Pacific/Fakaofo', 'Pacific/Fiji', 'Pacific/Funafuti', 'Pacific/Galapagos', 'Pacific/Gambier', 'Pacific/Guadalcanal', 'Pacific/Guam', 'Pacific/Honolulu', 'Pacific/Kiritimati', 'Pacific/Kosrae', 'Pacific/Kwajalein', 'Pacific/Majuro', 'Pacific/Marquesas', 'Pacific/Midway', 'Pacific/Nauru', 'Pacific/Niue', 'Pacific/Norfolk', 'Pacific/Noumea', 'Pacific/Pago_Pago', 'Pacific/Palau', 'Pacific/Pitcairn', 'Pacific/Ponape', 'Pacific/Port_Moresby', 'Pacific/Rarotonga', 'Pacific/Saipan', 'Pacific/Tahiti', 'Pacific/Tarawa', 'Pacific/Tongatapu', 'Pacific/Truk', 'Pacific/Wake', 'Pacific/Wallis', 'UTC')
     AND `billingRevision` IS NOT NULL AND `billingRevision` > 0
     AND `currentPeriodStartAt` IS NOT NULL AND `currentPeriodEndAt` IS NOT NULL AND `currentPeriodEndAt` > `currentPeriodStartAt`
     AND `earlyRenewalUsed` IS NOT NULL AND
       ((`earlyRenewalUsed` = false AND `earlyRenewedPeriodStartAt` IS NULL AND `earlyRenewalOrderId` IS NULL) OR
        (`earlyRenewalUsed` = true AND `earlyRenewedPeriodStartAt` IS NOT NULL AND `earlyRenewalOrderId` IS NOT NULL
         AND `earlyRenewedPeriodStartAt` = `currentPeriodStartAt`)))
);

-- System orders represent successful renewal purchases, not pending payment attempts.
-- Stable claims survive eligibility reset, clock rollover and replacement of the last marker.
CREATE UNIQUE INDEX `Order_renewal_eligibility_key` ON `Order`(`subscriptionId`,`billingRevisionSnapshot`,`renewalForPeriodStartAt`);
CREATE UNIQUE INDEX `Order_renewal_target_key` ON `Order`(`subscriptionId`,`billingRevisionSnapshot`,`renewalPeriodStartAt`);

CREATE UNIQUE INDEX `Order_renewal_request_key_hash_key` ON `Order`(`renewalRequestKeyHash`);

-- CHECK cannot compare OLD and NEW. These guards preserve renewal purchase evidence.
CREATE TRIGGER `Order_renewal_immutable_update` BEFORE UPDATE ON `Order`
FOR EACH ROW
BEGIN
  IF OLD.`source` = 'SYSTEM_RENEWAL' THEN
    IF OLD.`paymentStatus` IN ('PAID','REFUND_PENDING','REFUNDED') OR OLD.`paymentConfirmedAt` IS NOT NULL OR OLD.`fulfilledAt` IS NOT NULL THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAID_RENEWAL_IMMUTABLE';
    END IF;
    IF NOT (CAST(OLD.`id` AS BINARY) <=> CAST(NEW.`id` AS BINARY))
       OR NOT (CAST(OLD.`orderNo` AS BINARY) <=> CAST(NEW.`orderNo` AS BINARY))
       OR NOT (CAST(OLD.`userId` AS BINARY) <=> CAST(NEW.`userId` AS BINARY))
       OR NOT (CAST(OLD.`productId` AS BINARY) <=> CAST(NEW.`productId` AS BINARY))
       OR NOT (CAST(OLD.`subscriptionId` AS BINARY) <=> CAST(NEW.`subscriptionId` AS BINARY))
       OR NOT (CAST(OLD.`kind` AS BINARY) <=> CAST(NEW.`kind` AS BINARY))
       OR NOT (CAST(OLD.`source` AS BINARY) <=> CAST(NEW.`source` AS BINARY))
       OR NOT (CAST(OLD.`hidden` AS BINARY) <=> CAST(NEW.`hidden` AS BINARY))
       OR NOT (CAST(OLD.`productNameSnapshot` AS BINARY) <=> CAST(NEW.`productNameSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`productDescriptionSnapshot` AS BINARY) <=> CAST(NEW.`productDescriptionSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`productTypeSnapshot` AS BINARY) <=> CAST(NEW.`productTypeSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`priceSnapshotFen` AS BINARY) <=> CAST(NEW.`priceSnapshotFen` AS BINARY))
       OR NOT (CAST(OLD.`termSnapshot` AS BINARY) <=> CAST(NEW.`termSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`servicePeriodUnitSnapshot` AS BINARY) <=> CAST(NEW.`servicePeriodUnitSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`servicePeriodCountSnapshot` AS BINARY) <=> CAST(NEW.`servicePeriodCountSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`renewalPeriodStartAt` AS BINARY) <=> CAST(NEW.`renewalPeriodStartAt` AS BINARY))
       OR NOT (CAST(OLD.`renewalPeriodEndAt` AS BINARY) <=> CAST(NEW.`renewalPeriodEndAt` AS BINARY))
       OR NOT (CAST(OLD.`renewalForPeriodStartAt` AS BINARY) <=> CAST(NEW.`renewalForPeriodStartAt` AS BINARY))
       OR NOT (CAST(OLD.`billingAnchorSnapshotAt` AS BINARY) <=> CAST(NEW.`billingAnchorSnapshotAt` AS BINARY))
       OR NOT (CAST(OLD.`billingTimezoneSnapshot` AS BINARY) <=> CAST(NEW.`billingTimezoneSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`billingRevisionSnapshot` AS BINARY) <=> CAST(NEW.`billingRevisionSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`renewalRequestKeyHash` AS BINARY) <=> CAST(NEW.`renewalRequestKeyHash` AS BINARY))
       OR NOT (CAST(OLD.`renewalRequestHash` AS BINARY) <=> CAST(NEW.`renewalRequestHash` AS BINARY))
       OR NOT (CAST(OLD.`formSchemaSnapshot` AS BINARY) <=> CAST(NEW.`formSchemaSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`formData` AS BINARY) <=> CAST(NEW.`formData` AS BINARY))
       OR NOT (CAST(OLD.`amountFen` AS BINARY) <=> CAST(NEW.`amountFen` AS BINARY))
       OR NOT (CAST(OLD.`renewalPriceSnapshotFen` AS BINARY) <=> CAST(NEW.`renewalPriceSnapshotFen` AS BINARY))
       OR NOT (CAST(OLD.`contactEmailSnapshot` AS BINARY) <=> CAST(NEW.`contactEmailSnapshot` AS BINARY))
       OR NOT (CAST(OLD.`targetIdentifier` AS BINARY) <=> CAST(NEW.`targetIdentifier` AS BINARY))
       OR NOT (CAST(OLD.`createdByAdminId` AS BINARY) <=> CAST(NEW.`createdByAdminId` AS BINARY))
       OR NOT (CAST(OLD.`createdByUserId` AS BINARY) <=> CAST(NEW.`createdByUserId` AS BINARY))
       OR NOT (CAST(OLD.`createdAt` AS BINARY) <=> CAST(NEW.`createdAt` AS BINARY)) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'RENEWAL_SNAPSHOT_IMMUTABLE';
    END IF;
  END IF;
END;

CREATE TRIGGER `Order_paid_renewal_delete` BEFORE DELETE ON `Order`
FOR EACH ROW
BEGIN
  IF OLD.`source` = 'SYSTEM_RENEWAL' AND
     (OLD.`paymentStatus` IN ('PAID','REFUND_PENDING','REFUNDED') OR OLD.`paymentConfirmedAt` IS NOT NULL OR OLD.`fulfilledAt` IS NOT NULL) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'PAID_RENEWAL_IMMUTABLE';
  END IF;
END;
