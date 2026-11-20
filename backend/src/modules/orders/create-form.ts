import {
  hasCredentialFields,
  hasCredentialText,
} from '../../contracts/credential-fields.ts'
import { productFormSchema } from '../../contracts/product-form.ts'
import { parseFormData } from '../../contracts/form-data.ts'
import { ApiError } from '../../http/errors.ts'

export function creationForm(schemaInput: unknown, input: unknown) {
  const schema = productFormSchema.parse(schemaInput)
  if (hasCredentialFields(schema))
    throw new ApiError(400, 'INVALID_INPUT', '商品表单不得收集认证或付款凭证')
  const data = parseFormData(schema, input)
  const values = Object.values(data).flat()
  if (values.some((v) => typeof v === 'string' && hasCredentialText(v)))
    throw new ApiError(400, 'INVALID_INPUT', '表单不得包含认证或付款凭证')
  return data
}
