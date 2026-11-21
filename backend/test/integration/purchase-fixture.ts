import { productFormSchema } from '../../src/contracts/product-form.ts'

export const purchaseSchema = productFormSchema.parse({
  version: 1,
  fields: [
    {
      id: 'handle',
      type: 'text',
      label: '账号标识',
      required: true,
      hint: '<b>请输入公开标识</b>',
      defaultValue: 'editor-default-handle',
    },
    {
      id: 'contact',
      type: 'email',
      label: '联系邮箱',
      required: false,
      defaultValue: 'editor-default@example.com',
    },
    {
      id: 'note',
      type: 'textarea',
      label: '补充说明',
      required: false,
      defaultValue: 'editor-default-note',
    },
    {
      id: 'quantity',
      type: 'number',
      label: '数量',
      required: false,
      defaultValue: 3,
    },
    {
      id: 'date',
      type: 'date',
      label: '起始日期',
      required: false,
      defaultValue: '2026-11-01',
    },
    {
      id: 'region',
      type: 'select',
      label: '地区',
      required: false,
      options: [{ label: '亚洲', value: 'asia' }],
      defaultValue: 'asia',
    },
    {
      id: 'channel',
      type: 'radio',
      label: '联系渠道',
      required: false,
      options: [{ label: '邮件', value: 'email' }],
      defaultValue: 'email',
    },
    {
      id: 'topics',
      type: 'checkbox',
      label: '关注领域',
      required: false,
      options: [{ label: '学习', value: 'learning' }],
      defaultValue: ['learning'],
    },
  ],
})
