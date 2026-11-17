import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'node prisma/seed.ts' },
  // Generation works without local secrets. Database commands validate env first.
  datasource: { url: process.env.DATABASE_URL ?? '' },
})
