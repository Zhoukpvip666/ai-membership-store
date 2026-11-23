import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  defaultQrStorage,
  defaultCoverStorage,
  isPrivateCoverDirectory,
  isPrivateProductionImageDirectory,
} from './image-directories.ts'

const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
const mode = z
  .enum(['development', 'test', 'production'])
  .default('development')
const localMode = z.enum(['development', 'test']).default('development')
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

function localAppUrl(value: string) {
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
}

function productionAppUrl(value: string) {
  // Validate the original URL shape before WHATWG parsing can normalize paths,
  // credentials or an empty query/fragment away.
  if (!/^https:\/\/[a-zA-Z0-9.-]+(?::443)?\/?$/.test(value)) return false
  try {
    const { hostname } = new URL(value)
    return (
      !isIP(hostname) &&
      hostname.length <= 253 &&
      hostname.includes('.') &&
      hostname
        .split('.')
        .every((label) =>
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
        ) &&
      !/\.(?:localhost|local|internal|test|invalid|example)$/.test(hostname) &&
      !/(?:^|\.)example\.(?:com|net|org)$/.test(hostname)
    )
  } catch {
    return false
  }
}

const databaseEnv = z.object({ DATABASE_URL: localDatabaseUrl })
const productionDatabaseName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine(
    (name) =>
      ![
        'membership_store',
        'membership_preview',
        'mysql',
        'sys',
        'information_schema',
        'performance_schema',
      ].includes(name.toLowerCase()),
  )
const productionDatabaseUrl = localDatabaseUrl.refine((value) => {
  try {
    return decodeURIComponent(new URL(value).username).toLowerCase() !== 'root'
  } catch {
    return false
  }
})

const publicKeyPath = z
  .string()
  .refine((value) => isAbsolute(value) && !value.includes('\0'))

const adminCredentials = {
  ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  ADMIN_PASSWORD: z
    .string()
    .min(12)
    .max(128)
    .refine(
      (value) =>
        value.trim().length >= 12 && !value.startsWith('replace_with_'),
    ),
}
const localSeedEnv = databaseEnv.extend({
  NODE_ENV: localMode,
  ...adminCredentials,
})
const productionBootstrapEnv = z.object({
  NODE_ENV: z.literal('production'),
  PRODUCTION_DATABASE_NAME: productionDatabaseName,
  MYSQL_AUTH_PUBLIC_KEY_FILE: publicKeyPath,
  BOOTSTRAP_DATABASE_URL: productionDatabaseUrl,
  ...adminCredentials,
})
const productionMigrationEnv = z.object({
  PRODUCTION_DATABASE_NAME: productionDatabaseName,
  MYSQL_AUTH_PUBLIC_KEY_FILE: publicKeyPath,
  MIGRATION_DATABASE_URL: productionDatabaseUrl,
})
const productionRuntimeEnv = z.object({
  PRODUCTION_DATABASE_NAME: productionDatabaseName,
  MYSQL_AUTH_PUBLIC_KEY_FILE: publicKeyPath,
  DATABASE_URL: productionDatabaseUrl,
  TRUSTED_PROXY_IP: z.literal('127.0.0.1'),
})
const offlineSecrets = [
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'BOOTSTRAP_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'BACKUP_DATABASE_URL',
  'MYSQL_ROOT_PASSWORD',
] as const

const storageDirectory = z
  .string()
  .trim()
  .refine((value) => isAbsolute(value) && !value.includes('\0'))
  .optional()
const appEnv = databaseEnv
  .extend({
    NODE_ENV: mode,
    APP_BASE_URL: z.string(),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WECHAT_QR_STORAGE_DIR: storageDirectory,
    PRODUCT_COVER_STORAGE_DIR: storageDirectory,
  })
  .superRefine((env, context) => {
    const production = env.NODE_ENV === 'production'
    const originIsValid = production ? productionAppUrl : localAppUrl
    if (!originIsValid(env.APP_BASE_URL))
      context.addIssue({
        code: 'custom',
        path: ['APP_BASE_URL'],
        message: 'Invalid origin',
      })
    if (production)
      for (const field of [
        'WECHAT_QR_STORAGE_DIR',
        'PRODUCT_COVER_STORAGE_DIR',
      ] as const) {
        const directory = env[field]
        if (!directory || !isPrivateProductionImageDirectory(directory))
          context.addIssue({
            code: 'custom',
            path: [field],
            message: 'Use an explicit private directory outside the release',
          })
      }
    const qr =
      env.WECHAT_QR_STORAGE_DIR ?? (production ? undefined : defaultQrStorage)
    const cover =
      env.PRODUCT_COVER_STORAGE_DIR ??
      (production ? undefined : defaultCoverStorage)
    if (qr && cover && !isPrivateCoverDirectory(qr, cover))
      context.addIssue({
        code: 'custom',
        path: ['PRODUCT_COVER_STORAGE_DIR'],
        message:
          'Use private storage separate from the web root and QR storage',
      })
  })

export class EnvironmentError extends Error {
  constructor(fields: string[]) {
    super(
      'Invalid environment: ' +
        [...new Set(fields)].sort().join(', ') +
        '. Check .env.example.',
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

function requireDatabaseName(url: string, databaseName: string, field: string) {
  if (new URL(url).pathname !== '/' + databaseName)
    throw new EnvironmentError([field, 'PRODUCTION_DATABASE_NAME'])
}

export function requireProductionMode(input: NodeJS.ProcessEnv = process.env) {
  if (input.NODE_ENV !== 'production') throw new EnvironmentError(['NODE_ENV'])
}

export function parseEnvironment(input: NodeJS.ProcessEnv = process.env) {
  const env = parse(appEnv, input)
  let TRUSTED_PROXY_IP: '127.0.0.1' | undefined
  let MYSQL_AUTH_PUBLIC_KEY_FILE: string | undefined
  if (env.NODE_ENV === 'production') {
    const secrets = offlineSecrets.filter((field) => input[field] !== undefined)
    if (secrets.length) throw new EnvironmentError(secrets)
    const target = parse(productionRuntimeEnv, input)
    requireDatabaseName(
      target.DATABASE_URL,
      target.PRODUCTION_DATABASE_NAME,
      'DATABASE_URL',
    )
    TRUSTED_PROXY_IP = target.TRUSTED_PROXY_IP
    MYSQL_AUTH_PUBLIC_KEY_FILE = target.MYSQL_AUTH_PUBLIC_KEY_FILE
  }
  return { ...env, TRUSTED_PROXY_IP, MYSQL_AUTH_PUBLIC_KEY_FILE }
}

export const parseDatabaseEnvironment = (
  input: NodeJS.ProcessEnv = process.env,
) => parse(databaseEnv, input)

export const parseLocalSeedEnvironment = (
  input: NodeJS.ProcessEnv = process.env,
) => parse(localSeedEnv, input)

export function parseProductionBootstrapEnvironment(
  input: NodeJS.ProcessEnv = process.env,
) {
  const env = parse(productionBootstrapEnv, input)
  requireDatabaseName(
    env.BOOTSTRAP_DATABASE_URL,
    env.PRODUCTION_DATABASE_NAME,
    'BOOTSTRAP_DATABASE_URL',
  )
  return env
}

export function parseMigrationEnvironment(
  input: NodeJS.ProcessEnv = process.env,
) {
  if (parse(z.object({ NODE_ENV: mode }), input).NODE_ENV !== 'production')
    return {
      ...parseDatabaseEnvironment(input),
      MYSQL_AUTH_PUBLIC_KEY_FILE: undefined,
    }
  const env = parse(productionMigrationEnv, input)
  requireDatabaseName(
    env.MIGRATION_DATABASE_URL,
    env.PRODUCTION_DATABASE_NAME,
    'MIGRATION_DATABASE_URL',
  )
  return {
    DATABASE_URL: env.MIGRATION_DATABASE_URL,
    MYSQL_AUTH_PUBLIC_KEY_FILE: env.MYSQL_AUTH_PUBLIC_KEY_FILE,
  }
}

export type Environment = ReturnType<typeof parseEnvironment>
