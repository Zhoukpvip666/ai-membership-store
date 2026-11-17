import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  productFormSchema,
  MAX_FIELDS,
  type FormField,
} from '../src/contracts/product-form.ts'
import {
  createProduct,
  editProduct,
  completeProduct,
} from '../src/modules/products/schemas.ts'
import { editSettings } from '../src/modules/settings/service.ts'

const base = { label: '联系信息', required: false, hint: '仅限非敏感信息' }
export const allFields: FormField[] = [
  { ...base, id: 'f_text', type: 'text', defaultValue: '项目 A' },
  {
    ...base,
    id: 'f_email',
    type: 'email',
    defaultValue: 'fixture@example.com',
  },
  { ...base, id: 'f_area', type: 'textarea', defaultValue: '第一行\n第二行' },
  {
    ...base,
    id: 'f_select',
    type: 'select',
    options: [{ label: '方案 A', value: 'a' }],
    defaultValue: 'a',
  },
  {
    ...base,
    id: 'f_radio',
    type: 'radio',
    options: [{ label: '方案 B', value: 'b' }],
    defaultValue: 'b',
  },
  {
    ...base,
    id: 'f_check',
    type: 'checkbox',
    options: [{ label: '项目 C', value: 'c' }],
    defaultValue: ['c'],
  },
  { ...base, id: 'f_number', type: 'number', defaultValue: 1.5 },
  { ...base, id: 'f_date', type: 'date', defaultValue: '2028-02-29' },
]
const schema = (fields: unknown[]) => ({ version: 1, fields })
test('form configuration supports all eight types and stable IDs/defaults after reordering', () => {
  const parsed = productFormSchema.parse(schema(allFields))
  assert.equal(parsed.fields.length, 8)
  const reordered = productFormSchema.parse(schema([...allFields].reverse()))
  assert.deepEqual(
    reordered.fields.map((field) => field.id),
    [...allFields].reverse().map((field) => field.id),
  )
  assert.deepEqual(parsed.fields[5]!.defaultValue, ['c'])
  assert.deepEqual(productFormSchema.parse(schema([])), schema([]))
})
test('form configuration rejects duplicate/prototype IDs, unknown fields, executable types and excessive fields', () => {
  for (const input of [
    schema([allFields[0], allFields[0]]),
    schema([{ ...allFields[0], id: 'constructor' }]),
    schema([{ ...allFields[0], type: 'html' }]),
    schema([{ ...allFields[0], script: 'alert(1)' }]),
    schema([{ ...allFields[0], onChange: 'fetch("/")' }]),
    schema(
      Array.from({ length: MAX_FIELDS + 1 }, (_, i) => ({
        ...allFields[0],
        id: 'field_' + i,
      })),
    ),
    { version: 2, fields: [] },
  ])
    assert.equal(productFormSchema.safeParse(input).success, false)
})
test('choice options and defaults must be unique, bounded and type-correct', () => {
  for (const field of [
    { ...allFields[3], options: [] },
    {
      ...allFields[3],
      options: [
        { label: 'A', value: 'x' },
        { label: 'B', value: 'x' },
      ],
    },
    { ...allFields[3], options: [{ label: '', value: 'a' }] },
    { ...allFields[3], options: [{ label: 'A', value: '' }] },
    {
      ...allFields[3],
      options: Array.from({ length: 21 }, (_, i) => ({
        label: 'A',
        value: String(i),
      })),
    },
    { ...allFields[3], defaultValue: 'unknown' },
    { ...allFields[4], defaultValue: ['b'] },
    { ...allFields[5], defaultValue: ['c', 'c'] },
    { ...allFields[5], defaultValue: 'c' },
    { ...allFields[0], options: [{ label: 'A', value: 'a' }] },
  ])
    assert.equal(productFormSchema.safeParse(schema([field])).success, false)
})
test('defaults reject invalid emails, calendar dates, nonnumeric numbers and oversized schema', () => {
  for (const field of [
    { ...allFields[1], defaultValue: 'invalid' },
    { ...allFields[6], defaultValue: '1+1' },
    { ...allFields[6], defaultValue: Infinity },
    { ...allFields[7], defaultValue: '2026-02-29' },
    { ...allFields[7], defaultValue: '2026-13-01' },
    { ...allFields[7], defaultValue: 'new Date()' },
  ])
    assert.equal(productFormSchema.safeParse(schema([field])).success, false)
  assert.equal(
    productFormSchema.safeParse(
      schema(
        Array.from({ length: 20 }, (_, i) => ({
          ...allFields[0],
          id: 'f_' + i,
          defaultValue: '中'.repeat(500),
        })),
      ),
    ).success,
    false,
  )
  // Markup is inert text: renderers must interpolate, never v-html/eval it.
  assert.equal(
    productFormSchema.parse(
      schema([{ ...allFields[0], label: '<b>literal</b>' }]),
    ).fields[0]!.label,
    '<b>literal</b>',
  )
})
test('product requests validate integer fen, type constraints, unknown properties and defaults', () => {
  const valid = {
    name: '服务',
    type: 'SUBSCRIPTION',
    priceFen: 100,
    renewalPriceFen: 50,
    termLabel: '按供应商确认',
  }
  const parsed = createProduct.parse(valid)
  assert.equal(parsed.listed, false)
  assert.equal(parsed.sortOrder, 0)
  assert.deepEqual(parsed.formSchema, schema([]))
  for (const change of [
    { priceFen: 0.5 },
    { priceFen: -1 },
    { priceFen: 2147483648 },
    { priceFen: '100' },
    { type: 'INVALID' },
    { renewalPriceFen: null },
    { supplierCost: 1 },
    { password: 'no' },
    {
      formSchema: {
        version: 1,
        fields: [{ ...allFields[0], id: 'invalid id' }],
      },
    },
  ])
    assert.equal(
      createProduct.safeParse({ ...valid, ...change }).success,
      false,
    )
  assert.equal(
    createProduct.safeParse({
      ...valid,
      type: 'ONE_TIME',
      renewalPriceFen: null,
    }).success,
    true,
  )
  assert.equal(
    createProduct.safeParse({
      ...valid,
      type: 'ONE_TIME',
      renewalPriceFen: null,
      renewalEnabled: true,
    }).success,
    false,
  )
  assert.equal(editProduct.safeParse({}).success, false)
  assert.equal(editProduct.safeParse({ archivedAt: null }).success, false)
  for (const field of ['purchaseEnabled', 'renewalEnabled'])
    for (const value of [false, true]) {
      assert.equal(
        createProduct.safeParse({ ...valid, [field]: value }).success,
        false,
      )
      assert.equal(editProduct.safeParse({ [field]: value }).success, false)
    }
  assert.equal(
    completeProduct.safeParse({ ...parsed, type: 'ONE_TIME' }).success,
    false,
  )
})
test('settings accept only non-secret singleton fields and valid IANA timezone', () => {
  assert.deepEqual(
    editSettings.parse({
      storeName: ' 商店 ',
      ownerEmail: ' Owner@Example.com ',
      timezone: 'Asia/Shanghai',
    }),
    {
      storeName: '商店',
      ownerEmail: 'owner@example.com',
      timezone: 'Asia/Shanghai',
    },
  )
  for (const input of [
    {},
    { timezone: 'Not/A_Zone' },
    { timezone: '+08:00' },
    { smtpPassword: 'no' },
    { id: 2 },
    { ownerEmail: 'invalid' },
  ])
    assert.equal(editSettings.safeParse(input).success, false)
})
