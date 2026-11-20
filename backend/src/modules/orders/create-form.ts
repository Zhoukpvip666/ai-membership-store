import { hasCredentialFields } from '../../contracts/credential-fields.ts'
import { productFormSchema } from '../../contracts/product-form.ts'
import { parseFormData } from '../../contracts/form-data.ts'
import { ApiError } from '../../http/errors.ts'

// Guard obvious credential collection even for old catalog configurations. Plain
// account identifiers remain allowed; this does not attempt to classify arbitrary text.
const credentialValue =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:password|passwd|otp|access[_ -]?token|session[_ -]?(?:cookie|token)|api[_ -]?key|密码|验证码)\s*[:=]\s*\S+/i

export function creationForm(schemaInput: unknown, input: unknown) {
  const schema = productFormSchema.parse(schemaInput)
  if (hasCredentialFields(schema))
    throw new ApiError(400, 'INVALID_INPUT', '商品表单不得收集认证或付款凭证')
  const data = parseFormData(schema, input)
  const values = Object.values(data).flat()
  if (values.some((v) => typeof v === 'string' && credentialValue.test(v)))
    throw new ApiError(400, 'INVALID_INPUT', '表单不得包含认证或付款凭证')
  return data
}
