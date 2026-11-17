import { parseEnvironment } from '../../src/config/env.ts'

export function integrationEnvironment() {
  if (
    !/^membership-foundation-[a-f0-9]{12}$/.test(
      process.env.FOUNDATION_DB_TEST ?? '',
    )
  ) {
    throw new Error(
      'Use npm run test:db; integration fixtures must never run against the development database.',
    )
  }
  const env = parseEnvironment()
  const url = new URL(env.DATABASE_URL)
  if (
    url.pathname !== '/foundation_test' ||
    decodeURIComponent(url.username) !== 'foundation_test'
  ) {
    throw new Error(
      'Refusing to write fixtures outside the isolated foundation_test database.',
    )
  }
  return env
}
