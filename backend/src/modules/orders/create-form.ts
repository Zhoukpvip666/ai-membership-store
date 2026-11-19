import { productFormSchema } from '../../contracts/product-form.ts'
import { parseFormData } from '../../contracts/form-data.ts'
import { ApiError } from '../../http/errors.ts'

// Guard obvious credential collection even for old catalog configurations. Plain
// account identifiers remain allowed; this does not attempt to classify arbitrary text.
const credentialField =
  /password|passwd|passcode|onetimepassword|otp|2fa|twofactor|recoverycode|backupcode|sessioncookie|sessiontoken|accesstoken|refreshtoken|apikey|privatekey|cardnumber|securitycode|bankcredential|密码|验证码|恢复码|备份码|密钥|会话令牌|会话cookie|银行卡号|信用卡号/i
const credentialValue =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|passwd|otp|access[_ -]?token|session[_ -]?(?:cookie|token)|api[_ -]?key|密码|验证码)\s*[:=]\s*\S+/i

export function creationForm(schemaInput: unknown, input: unknown) {
  const schema = productFormSchema.parse(schemaInput)
  const forbidden = schema.fields.some((field) =>
    credentialField.test(
      [field.id, field.label, field.hint]
        .join(' ')
        .normalize('NFKC')
        .replace(/[\s_-]/g, ''),
    ),
  )
  if (forbidden)
    throw new ApiError(400, 'INVALID_INPUT', '商品表单不得收集认证或付款凭证')
  const data = parseFormData(schema, input)
  const values = Object.values(data).flat()
  if (values.some((v) => typeof v === 'string' && credentialValue.test(v)))
    throw new ApiError(400, 'INVALID_INPUT', '表单不得包含认证或付款凭证')
  return data
}
