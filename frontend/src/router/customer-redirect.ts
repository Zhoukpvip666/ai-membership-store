export function isPurchasePath(path: string) {
  return /^\/purchase\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(path)
}

export function isCustomerRedirect(path: string) {
  return (
    ['/profile', '/orders', '/account/orders', '/subscriptions'].includes(
      path,
    ) || isPurchasePath(path)
  )
}
