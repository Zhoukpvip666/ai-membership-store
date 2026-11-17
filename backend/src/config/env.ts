import { z } from 'zod'

const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
const localDatabaseUrl = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'mysql:' &&
      loopback.has(url.hostname) &&
      Boolean(decodeURIComponent(url.username)) &&
      Boolean(decodeURIComponent(url.password)) &&
      !decodeURIComponent(url.password).startsWith('replace_with_') &&
      /^[A-Za-z0-9_]+$/.test(url.pathname.slice(1)) &&
      (!url.port || (Number(url.port) > 0 && Number(url.port) <= 65535)) &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
})
const localAppUrl = z.string().refine((value) => {
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      loopback.has(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
    )
  } catch {
    return false
  }
})

const databaseEnv = z.object({ DATABASE_URL: localDatabaseUrl })
const appEnv = databaseEnv.extend({
  APP_BASE_URL: localAppUrl,
  ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  ADMIN_PASSWORD: z
    .string()
    .min(12)
    .max(128)
    .refine(
      (value) =>
        value.trim().length >= 12 && !value.startsWith('replace_with_'),
    ),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
})

export class EnvironmentError extends Error {
  constructor(fields: string[]) {
    super(
      `Invalid environment: ${[...new Set(fields)].sort().join(', ')}. Check .env.example.`,
    )
    this.name = 'EnvironmentError'
  }
}

function parse<T extends z.ZodType>(
  schema: T,
  input: NodeJS.ProcessEnv,
): z.output<T> {
  const result = schema.safeParse(input)
  if (!result.success) {
    // Zod issue text/input may contain credentials. Expose field names only.
    throw new EnvironmentError(
      result.error.issues.map((issue) => String(issue.path[0])),
    )
  }
  return result.data
}

export const parseEnvironment = (input: NodeJS.ProcessEnv = process.env) =>
  parse(appEnv, input)
export const parseDatabaseEnvironment = (
  input: NodeJS.ProcessEnv = process.env,
) => parse(databaseEnv, input)
export type Environment = ReturnType<typeof parseEnvironment>
