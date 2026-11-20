import type { ProductFormSchema } from './product-form.ts'

// Shared browser/server policy: ordinary service forms must not solicit credentials.
const credentialField =
  /password|passwd|passcode|onetimepassword|otp|2fa|twofactor|recoverycode|backupcode|sessioncookie|sessiontoken|accesstoken|refreshtoken|apikey|privatekey|cardnumber|securitycode|bankcredential|密码|验证码|恢复码|备份码|密钥|会话令牌|会话cookie|银行卡号|信用卡号/i

export function hasCredentialFields(schema: ProductFormSchema) {
  return schema.fields.some((field) =>
    credentialField.test(
      [field.id, field.label, field.hint]
        .join(' ')
        .normalize('NFKC')
        .replace(/[\s_-]/g, ''),
    ),
  )
}
