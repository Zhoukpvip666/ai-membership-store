import { describe, expect, it } from 'vitest'
import { productFormSchema } from '../../../../backend/src/contracts/product-form'
import { purchaseErrors } from './purchase-validation'

const schema = productFormSchema.parse({
  version: 1,
  fields: [
    { id: 'handle', type: 'text', label: '账号标识', required: true },
    { id: 'email', type: 'email', label: '邮箱', required: false },
    { id: 'date', type: 'date', label: '日期', required: false },
    { id: 'quantity', type: 'number', label: '数量', required: false },
    ...(['select', 'radio', 'checkbox'] as const).map((type) => ({
      id: type,
      type,
      label: type,
      required: false,
      options: [{ label: '亚洲', value: 'asia' }],
    })),
  ],
})

describe('purchase form validation', () => {
  it('accepts valid values and omits optional answers', () => {
    expect(
      purchaseErrors(schema, {
        handle: 'public-user',
        date: '2028-02-29',
        quantity: 0,
        select: 'asia',
        radio: 'asia',
        checkbox: ['asia'],
      }),
    ).toEqual([])
  })

  it('reports each invalid field by label with a safe reason', () => {
    expect(
      purchaseErrors(schema, {
        handle: ' ',
        email: 'invalid',
        date: '2026-02-29',
        quantity: Number.MAX_SAFE_INTEGER + 1,
        select: 'unknown',
        radio: 'unknown',
        checkbox: ['asia', 'asia', 'unknown'],
      }),
    ).toEqual([
      '账号标识 · 请填写必填项',
      '邮箱 · 请输入有效的邮箱地址',
      '日期 · 请输入有效的日期',
      '数量 · 请输入有效范围内的数字',
      'select · 请选择提供的选项',
      'radio · 请选择提供的选项',
      'checkbox · 请选择提供的选项，每项只能选一次',
    ])
  })

  it('uses the shared credential detector without reflecting answers', () => {
    expect(
      purchaseErrors(schema, { handle: 'API key: fictional-only' }),
    ).toEqual(['账号标识 · 不得填写认证凭证'])
    expect(
      purchaseErrors(schema, { handle: 'public-user', injected: 'x' }),
    ).toEqual(['表单包含未知字段'])
  })

  it('applies the shared byte limit across individually valid answers', () => {
    const fields = Array.from({ length: 20 }, (_, index) => ({
      id: 'field' + index,
      type: 'textarea',
      label: '项目 ' + index,
      required: false,
    }))
    const wide = productFormSchema.parse({ version: 1, fields })
    const values = Object.fromEntries(
      fields.map(({ id }) => [id, '中'.repeat(300)]),
    )
    expect(purchaseErrors(wide, values)).toEqual(['填写信息不能超过 8 KiB'])
  })
})
