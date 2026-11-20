import type { ProductFormSchema } from './product-form.ts'

// Shared browser/server policy: ordinary service forms must not solicit credentials.
const credentialField =
  /password|passwd|passcode|onetimepassword|otp|2fa|twofactor|recoverycode|backupcode|sessioncookie|sessiontoken|accesstoken|refreshtoken|apikey|privatekey|cardnumber|securitycode|bankcredential|密码|验证码|恢复码|备份码|密钥|会话令牌|会话cookie|银行卡号|信用卡号/i

const credentialValue =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|passwd|otp|access[_ -]?token|session[_ -]?(?:cookie|token)|api[_ -]?key|密码|验证码)\s*[:=]\s*\S+/i

export function hasCredentialText(value: string) {
  return credentialValue.test(value)
}

export function hasCredentialValues(value: unknown): boolean {
  if (typeof value === 'string') return hasCredentialText(value)
  if (Array.isArray(value)) return value.some(hasCredentialValues)
  return (
    !!value &&
    typeof value === 'object' &&
    Object.values(value).some(hasCredentialValues)
  )
}

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
