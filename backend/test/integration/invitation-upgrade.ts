import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createDatabase } from '../../src/db/client.ts'
import {
  CustomerCredentialsMigrationError,
  migrationPreflight,
} from '../../src/db/migration-preflight.ts'
import { authService } from '../../src/modules/auth/service.ts'
import { newToken, tokenHash } from '../../src/modules/auth/security.ts'
import { buildOrderSnapshot } from '../../src/modules/orders/revisions.ts'
import { businessSnapshot } from './order-source-support.ts'
import { activeCredentials, integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
const [phase, path] = process.argv.slice(2)
assert(path)

const snapshot = async () => ({
  records: await businessSnapshot(db),
  OrderRevision: await db.orderRevision.findMany({ orderBy: { id: 'asc' } }),
})

async function prepare() {
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  const identities = await activeCredentials()
  const [pending, neverActivatedDisabled] = await Promise.all(
    (['PENDING_ACTIVATION', 'DISABLED'] as const).map((status) =>
      db.user.create({
        data: {
          status,
          loginEmail: randomUUID() + '@example.test',
          notificationEmail: randomUUID() + '@example.test',
          adminLabel: 'Legacy customer',
          createdByAdminId: admin.id,
        },
      }),
    ),
  )
  for (const status of ['ACTIVE', 'DISABLED'] as const)
    await db.user.create({
      data: {
        ...identities,
        status,
        loginEmail: randomUUID() + '@example.test',
        notificationEmail: randomUUID() + '@example.test',
        createdByAdminId: admin.id,
      },
    })
  const unclassified = await db.user.create({
    data: { loginEmail: 'unclassified@example.test' },
  })
  await db.user.create({
    data: {
      loginEmail: 'unverified-creator@example.test',
      createdByAdminId: unclassified.id,
    },
  })
  const invalidActive = await db.user.create({
    data: { loginEmail: 'invalid-active@example.test', status: 'ACTIVE' },
  })
  await assert.rejects(
    migrationPreflight(db),
    CustomerCredentialsMigrationError,
  )
  await db.user.delete({ where: { id: invalidActive.id } })
  const classification = await migrationPreflight(db)
  assert.deepEqual(classification, { total: 7, cleanup: 2, unclassified: 2 })

  const product = await db.product.create({
    data: {
      slug: randomUUID(),
      name: 'Legacy product',
      type: 'SUBSCRIPTION',
      termLabel: 'Month',
      priceFen: 100,
      renewalPriceFen: 100,
      servicePeriodUnit: 'MONTH',
      servicePeriodCount: 1,
    },
  })
  const order = await db.order.create({
    data: {
      orderNo: randomUUID(),
      userId: pending.id,
      productId: product.id,
      source: 'ADMIN',
      createdByAdminId: admin.id,
      kind: 'INITIAL',
      productTypeSnapshot: 'SUBSCRIPTION',
      productNameSnapshot: product.name,
      termSnapshot: product.termLabel,
      amountFen: product.priceFen,
      priceSnapshotFen: product.priceFen,
      renewalPriceSnapshotFen: 100,
      servicePeriodUnitSnapshot: 'MONTH',
      servicePeriodCountSnapshot: 1,
      contactEmailSnapshot: pending.loginEmail,
    },
  })
  await db.orderRevision.create({
    data: {
      orderId: order.id,
      version: 1,
      snapshotSchemaVersion: 1,
      actorUserId: admin.id,
      actorType: 'ADMIN',
      snapshotJson: buildOrderSnapshot(order),
    },
  })
  await db.subscription.create({
    data: {
      userId: pending.id,
      productId: product.id,
      createdByAdminId: admin.id,
      sourceType: 'ADMIN',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
      renewalPriceFen: 100,
      productNameSnapshot: product.name,
      productTypeSnapshot: product.type,
      termSnapshot: product.termLabel,
      priceSnapshotFen: product.priceFen,
    },
  })
  const invitationToken = newToken()
  await db.invitationToken.create({
    data: {
      userId: pending.id,
      tokenHash: tokenHash(invitationToken),
      createdByAdminId: admin.id,
      expiresAt: new Date(Date.now() + 86400000),
    },
  })
  const expected = await snapshot()
  for (const user of expected.records.User) {
    if (user.id === pending.id || user.id === neverActivatedDisabled.id) {
      user.loginEmail = null
      user.notificationEmail = null
    }
  }
  writeFileSync(
    path,
    JSON.stringify({ expected, profileId: pending.id, invitationToken }),
    {
      mode: 0o600,
    },
  )
  console.info(
    'Prepared a populated 14-migration database, including an existing invitation, protected order revision and previously activated accounts.',
  )
}

async function verify() {
  const { expected, profileId, invitationToken } = JSON.parse(
    readFileSync(path, 'utf8'),
  )
  assert.deepEqual(JSON.parse(JSON.stringify(await snapshot())), expected)
  const [history] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  assert.equal(Number(history.count), 15)

  const valid = {
    loginEmail: 'new@example.test',
    ...(await activeCredentials()),
  }
  for (const invalid of [
    { ...valid, loginEmail: null },
    { ...valid, loginEmail: 'invalid' },
    { ...valid, passwordHash: null },
    { ...valid, activatedAt: null },
  ])
    await assert.rejects(
      db.user.create({ data: { ...invalid, status: 'ACTIVE' } }),
      /User_active_credentials_check|3819/,
    )
  const auth = authService(db)
  const registered = await auth.register(
    'claimed-legacy@example.test',
    'IsolatedMigratedInvitation123!',
    invitationToken,
  )
  assert.equal(registered.user.id, profileId)
  assert.equal((await auth.resolve(registered.token))?.user.id, profileId)
  assert.equal(await db.order.count({ where: { userId: profileId } }), 1)
  assert.equal(await db.subscription.count({ where: { userId: profileId } }), 1)
  console.info(
    'Verified exact history, targeted NULL cleanup, active-identity CHECK and successful claim of a pre-migration invitation.',
  )
}

try {
  if (phase === 'before') await prepare()
  else {
    assert.equal(phase, 'after')
    await verify()
  }
} finally {
  await db.$disconnect()
}
