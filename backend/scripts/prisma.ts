import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  parseDatabaseEnvironment,
  EnvironmentError,
} from '../src/config/env.ts'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
try {
  const offline =
    ['generate', 'validate', 'format'].includes(args[0] ?? '') ||
    (args[0] === 'migrate' &&
      args[1] === 'diff' &&
      args.includes('--from-empty') &&
      args.includes('--to-schema'))
  if (!offline) parseDatabaseEnvironment()
  const result = spawnSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), ...args],
    {
      stdio: 'inherit',
      env: process.env,
    },
  )
  process.exitCode = result.status ?? 1
} catch (error) {
  console.error(
    error instanceof EnvironmentError
      ? error.message
      : 'Prisma command failed.',
  )
  process.exitCode = 1
}
