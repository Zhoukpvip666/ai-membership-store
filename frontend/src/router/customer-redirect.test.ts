import { expect, it } from 'vitest'
import { customerRedirect } from './customer-redirect'

it('preserves customer destinations and accepts strict purchase paths', () => {
  for (const path of [
    '/profile',
    '/orders',
    '/account/orders',
    '/subscriptions',
    '/purchase/product-ABC_123',
    '/purchase/' + 'a'.repeat(100),
  ])
    expect(customerRedirect(path)).toBe(path)
})

it('rejects external, malformed and noncanonical redirect paths', () => {
  for (const path of [
    'https://evil.example',
    '//evil.example',
    '\\\\evil.example',
    '/purchase/../admin',
    '/purchase/%2e%2e',
    '/purchase/a%2fb',
    '/purchase/%',
    '/purchase/a?next=//evil.example',
    '/purchase/a#fragment',
    '/purchase/a\n',
    '/purchase//a',
    '/purchase/_a',
    '/purchase/' + 'a'.repeat(101),
    '/admin/orders',
    ['/purchase/valid-slug', '/admin/orders'],
    null,
    undefined,
  ])
    expect(customerRedirect(path)).toBeUndefined()
})
