import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'node prisma/seed.ts' },
  // Generation works without local secrets. Database commands validate env first.
  datasource: {
    url:
      (process.env.NODE_ENV === 'production'
        ? process.env.MIGRATION_DATABASE_URL
        : process.env.DATABASE_URL) ?? '',
  },
})
