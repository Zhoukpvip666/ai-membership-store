import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { verify } from 'argon2'
import { createDatabase } from '../../src/db/client.ts'
import { Prisma } from '../../src/generated/prisma/client.ts'
import { seedAdministrator, SeedConflictError } from '../../src/db/seed.ts'
import { integrationEnvironment } from './support.ts'

const env = integrationEnvironment()
const db = createDatabase(env.DATABASE_URL)
after(() => db.$disconnect())
let adminId: string
let customerId: string
let productId: string
let subscriptionId: string
let orderId: string
const isPrismaError = (code: string) => (error: unknown) =>
  Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code,
  )

test('migration creates twelve domain tables and seven migration records', async () => {
  const tables = await db.$queryRaw<{ name: string }[]>`
    SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`
  assert.deepEqual(
    tables.map((t) => t.name).sort(),
    [
      'AdminAuditLog',
      'AppSettings',
      'InvitationToken',
      'IdempotencyRecord',
      'Order',
      'OrderEvent',
      'PaymentTransaction',
      'Product',
      'Session',
      'Subscription',
      'SubscriptionEvent',
      'User',
      '_prisma_migrations',
    ].sort(),
  )
  const versions = await db.$queryRaw<
    { version: string }[]
  >`SELECT VERSION() AS version`
  assert.match(versions[0]!.version, /^8\.4\./)
  const zones = await db.$queryRaw<
    { zone: string }[]
  >`SELECT @@session.time_zone AS zone`
  assert.equal(zones[0]!.zone, '+00:00')
  const migrations = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`
  assert.equal(Number(migrations[0]!.count), 7)
  assert.equal(await db.user.count(), 0)
})

test('schema keeps documented types, unique/index keys, singleton and restrictive foreign keys', async () => {
  const columns = await db.$queryRaw<
    {
      tableName: string
      name: string
      dataType: string
      datePrecision: bigint | null
      isNullable: string
    }[]
  >`
    SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, DATA_TYPE AS dataType,
           DATETIME_PRECISION AS datePrecision, IS_NULLABLE AS isNullable
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME <> '_prisma_migrations'`
  for (const column of columns) {
    if (/Fen$/.test(column.name)) assert.equal(column.dataType, 'int')
    if (column.dataType === 'datetime')
      assert.equal(Number(column.datePrecision), 3)
    assert.ok(!/supplier|wallet|withdrawal|profit|rawToken/i.test(column.name))
  }
  assert(
    !columns.some(
      (column) =>
        column.tableName === 'Product' &&
        ['purchaseEnabled', 'renewalEnabled'].includes(column.name),
    ),
  )
  for (const name of ['listed', 'archivedAt', 'formSchema', 'sortOrder'])
    assert(
      columns.some(
        (column) => column.tableName === 'Product' && column.name === name,
      ),
    )
  assert.equal(
    columns.find((c) => c.tableName === 'User' && c.name === 'passwordHash')
      ?.isNullable,
    'YES',
  )
  const keys = await db.$queryRaw<
    { tableName: string; indexColumns: string; nonUnique: bigint }[]
  >`
    SELECT TABLE_NAME AS tableName, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS indexColumns, NON_UNIQUE AS nonUnique
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
    GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`
  for (const [tableName, fields] of [
    ['User', 'loginEmail'],
    ['Session', 'tokenHash'],
    ['InvitationToken', 'tokenHash'],
    ['Product', 'slug'],
    ['Order', 'orderNo'],
    ['Subscription', 'sourceOrderId'],
  ])
    assert.ok(
      keys.some(
        (k) =>
          k.tableName === tableName &&
          k.indexColumns === fields &&
          Number(k.nonUnique) === 0,
      ),
      `Missing unique key: ${tableName}.${fields}`,
    )
  for (const [tableName, fields] of [
    ['Product', 'archivedAt,sortOrder,createdAt'],
    ['Order', 'userId,createdAt'],
    ['Order', 'paymentStatus,createdAt'],
    ['Order', 'fulfillmentStatus,createdAt'],
    ['Order', 'subscriptionId,createdAt'],
    ['PaymentTransaction', 'orderId,kind,status'],
    ['Subscription', 'userId,status'],
    ['Subscription', 'expiresAt,status'],
    ['SubscriptionEvent', 'subscriptionId,createdAt'],
    ['OrderEvent', 'orderId,createdAt'],
    ['AdminAuditLog', 'actorAdminId,createdAt'],
  ])
    assert.ok(
      keys.some((k) => k.tableName === tableName && k.indexColumns === fields),
      `Missing index: ${tableName}.${fields}`,
    )
  const constraints = await db.$queryRaw<{ deleteRule: string }[]>`
    SELECT DELETE_RULE AS deleteRule FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()`
  assert.ok(constraints.length >= 20)
  assert.ok(constraints.every((c) => c.deleteRule === 'RESTRICT'))
  await assert.rejects(
    db.appSettings.create({
      data: { id: 2, storeName: 'Invalid', ownerEmail: 'test@example.com' },
    }),
  )
})

test('seed refuses a customer email collision without promoting or partially seeding', async () => {
  const customer = await db.user.create({
    data: { loginEmail: env.ADMIN_EMAIL, adminLabel: 'Collision fixture' },
  })
  await assert.rejects(seedAdministrator(db, env), SeedConflictError)
  assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 0)
  assert.equal(await db.appSettings.count(), 0)
  assert.equal(await db.adminAuditLog.count(), 0)
  assert.equal(
    (await db.user.findUniqueOrThrow({ where: { id: customer.id } })).role,
    'CUSTOMER',
  )
  await db.user.delete({ where: { id: customer.id } })
})

test('concurrent and repeated seeds create one Argon2id administrator and preserve password/profile/settings', async () => {
  const results = await Promise.all([
    seedAdministrator(db, env),
    seedAdministrator(db, env),
  ])
  assert.equal(results.filter((r) => r.created).length, 1)
  assert.equal(await db.user.count(), 1)
  const admin = await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })
  adminId = admin.id
  assert.equal(admin.status, 'ACTIVE')
  assert.equal(admin.loginEmail, env.ADMIN_EMAIL)
  assert.ok(admin.activatedAt instanceof Date)
  assert.ok(admin.passwordHash?.startsWith('$argon2id$v=19$m=19456,t=2,p=1$'))
  assert.ok(await verify(admin.passwordHash!, env.ADMIN_PASSWORD))
  assert.ok(
    !(await verify(admin.passwordHash!, 'incorrect-local-test-password')),
  )
  await db.user.update({
    where: { id: adminId },
    data: { adminLabel: 'Preserved owner profile' },
  })
  await db.appSettings.update({
    where: { id: 1 },
    data: { storeName: 'Preserved store settings' },
  })
  const before = await db.user.findUniqueOrThrow({ where: { id: adminId } })
  const settingsBefore = await db.appSettings.findUniqueOrThrow({
    where: { id: 1 },
  })
  const changedPassword = randomBytes(24).toString('hex')
  assert.equal(
    (await seedAdministrator(db, { ...env, ADMIN_PASSWORD: changedPassword }))
      .created,
    false,
  )
  const after = await db.user.findUniqueOrThrow({ where: { id: adminId } })
  assert.ok(
    JSON.stringify(before) === JSON.stringify(after),
    'Seed changed existing administrator data',
  )
  assert.ok(!(await verify(after.passwordHash!, changedPassword)))
  assert.deepEqual(
    await db.appSettings.findUniqueOrThrow({ where: { id: 1 } }),
    settingsBefore,
  )
  const logs = await db.adminAuditLog.findMany()
  assert.equal(logs.length, 1)
  assert.deepEqual(logs[0]!.afterJson, { role: 'ADMIN', status: 'ACTIVE' })
  assert.ok(!JSON.stringify(logs).includes(env.ADMIN_PASSWORD))
  assert.ok(!JSON.stringify(logs).includes(admin.passwordHash!))
})

test('seed rejects changed admin email and multiple-admin corruption without overwriting accounts', async () => {
  await assert.rejects(
    seedAdministrator(db, { ...env, ADMIN_EMAIL: 'other-owner@example.com' }),
    SeedConflictError,
  )
  const extra = await db.user.create({
    data: {
      loginEmail: 'corrupt-admin@example.com',
      adminLabel: 'Corrupt fixture',
      role: 'ADMIN',
    },
  })
  await assert.rejects(seedAdministrator(db, env), SeedConflictError)
  assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 2)
  assert.equal(await db.adminAuditLog.count(), 1)
  await db.user.delete({ where: { id: extra.id } })
  assert.equal(await db.user.count({ where: { role: 'ADMIN' } }), 1)
})

test('pending customers can hold multiple manual/import entitlements without fake orders or payments', async () => {
  const user = await db.user.create({
    data: {
      loginEmail: 'pending-customer@example.com',
      adminLabel: 'Pending fixture',
      createdByAdminId: adminId,
    },
  })
  customerId = user.id
  assert.equal(user.status, 'PENDING_ACTIVATION')
  assert.equal(user.passwordHash, null)
  const product = await db.product.create({
    data: {
      slug: 'fixture-subscription',
      name: 'Fixture subscription',
      type: 'SUBSCRIPTION',
      priceFen: 12900,
      renewalPriceFen: 9900,
      termLabel: 'Supplier-confirmed term',
      targetField: 'EMAIL',
      listed: true,
    },
  })
  productId = product.id
  const dates = {
    startedAt: new Date('2026-11-16T01:02:03.123Z'),
    expiresAt: new Date('2026-12-16T01:02:03.456Z'),
  }
  for (const sourceType of ['MANUAL_GRANT', 'HISTORICAL_IMPORT'] as const) {
    const subscription = await db.subscription.create({
      data: {
        userId: customerId,
        productId,
        sourceType: 'ADMIN',
        productNameSnapshot: product.name,
        productDescriptionSnapshot: product.description,
        productTypeSnapshot: product.type,
        priceSnapshotFen: product.priceFen,
        termSnapshot: product.termLabel,
        targetIdentifier: 'service@example.com',
        ...dates,
        renewalPriceFen: 9900,
        createdByAdminId: adminId,
      },
    })
    subscriptionId = subscription.id
    assert.equal(subscription.sourceOrderId, null)
    assert.equal(subscription.status, 'ACTIVE')
    assert.deepEqual(subscription.startedAt, dates.startedAt)
    assert.deepEqual(subscription.expiresAt, dates.expiresAt)
    await db.subscriptionEvent.create({
      data: {
        subscriptionId,
        actorAdminId: adminId,
        eventType: sourceType,
        newStartedAt: dates.startedAt,
        newExpiresAt: dates.expiresAt,
        reason: 'Test fixture only',
      },
    })
  }
  assert.equal(
    await db.subscription.count({ where: { userId: customerId, productId } }),
    2,
  )
  assert.equal(await db.order.count(), 0)
  assert.equal(await db.paymentTransaction.count(), 0)
})

test('all remaining model relations, UTC snapshots and unique source-order links round trip', async () => {
  const order = await db.order.create({
    data: {
      orderNo: 'TEST-INITIAL',
      userId: customerId,
      productId,
      kind: 'INITIAL',
      productNameSnapshot: 'Immutable fixture name',
      productTypeSnapshot: 'SUBSCRIPTION',
      termSnapshot: 'Confirmed term',
      amountFen: 12900,
      renewalPriceSnapshotFen: 9900,
      contactEmailSnapshot: 'pending-customer@example.com',
      targetIdentifier: 'service@example.com',
      createdByAdminId: adminId,
    },
  })
  orderId = order.id
  assert.equal(order.source, 'OFFLINE_MANUAL')
  assert.equal(order.paymentStatus, 'UNPAID')
  assert.equal(order.fulfillmentStatus, 'NOT_STARTED')
  await db.order.create({
    data: {
      ...order,
      formSchemaSnapshot: order.formSchemaSnapshot ?? Prisma.DbNull,
      formData: order.formData ?? Prisma.DbNull,
      id: undefined,
      orderNo: 'TEST-RENEWAL',
      kind: 'RENEWAL',
      subscriptionId,
    },
  })
  const entitlement = {
    userId: customerId,
    productId,
    sourceType: 'ADMIN' as const,
    productNameSnapshot: 'Fixture snapshot',
    productTypeSnapshot: 'SUBSCRIPTION' as const,
    priceSnapshotFen: 12900,
    termSnapshot: 'Frozen term',
    sourceOrderId: orderId,
    targetIdentifier: 'service@example.com',
    startedAt: new Date('2026-11-16T01:02:03.123Z'),
    expiresAt: new Date('2026-12-16T01:02:03.456Z'),
    renewalPriceFen: 9900,
    createdByAdminId: adminId,
  }
  await db.subscription.create({ data: entitlement })
  await assert.rejects(
    db.subscription.create({ data: entitlement }),
    isPrismaError('P2002'),
  )
  const occurredAt = new Date('2026-11-16T12:34:56.789Z')
  const transaction = await db.paymentTransaction.create({
    data: {
      orderId,
      kind: 'PAYMENT',
      channel: 'WECHAT',
      amountFen: 12900,
      occurredAt,
      createdByAdminId: adminId,
    },
  })
  assert.equal(transaction.status, 'PENDING')
  assert.deepEqual(transaction.occurredAt, occurredAt)
  await db.orderEvent.create({
    data: {
      orderId,
      actorAdminId: adminId,
      eventType: 'ORDER_CREATED',
      toStateJson: {
        paymentStatus: 'UNPAID',
        fulfillmentStatus: 'NOT_STARTED',
      },
    },
  })
  await db.subscriptionEvent.create({
    data: { subscriptionId, orderId, actorAdminId: adminId, eventType: 'NOTE' },
  })
  const tokenHash = createHash('sha256').update(randomBytes(32)).digest('hex')
  const expiresAt = new Date('2026-12-16T12:34:56.789Z')
  await db.session.create({
    data: { userId: customerId, tokenHash, expiresAt },
  })
  await db.invitationToken.create({
    data: {
      userId: customerId,
      tokenHash,
      expiresAt,
      createdByAdminId: adminId,
    },
  })
  await assert.rejects(
    db.session.create({ data: { userId: customerId, tokenHash, expiresAt } }),
    isPrismaError('P2002'),
  )
  await assert.rejects(
    db.invitationToken.create({
      data: {
        userId: customerId,
        tokenHash,
        expiresAt,
        createdByAdminId: adminId,
      },
    }),
    isPrismaError('P2002'),
  )
  await assert.rejects(
    db.user.create({
      data: {
        loginEmail: 'PENDING-CUSTOMER@EXAMPLE.COM',
        adminLabel: 'Duplicate',
      },
    }),
    isPrismaError('P2002'),
  )
  await db.product.update({
    where: { id: productId },
    data: {
      name: 'Changed current product',
      priceFen: 19900,
      archivedAt: new Date(),
    },
  })
  const snapshot = await db.order.findUniqueOrThrow({ where: { id: orderId } })
  assert.equal(snapshot.productNameSnapshot, 'Immutable fixture name')
  assert.equal(snapshot.amountFen, 12900)
  assert.equal(
    (
      await db.subscription.findUniqueOrThrow({
        where: { sourceOrderId: orderId },
      })
    ).renewalPriceFen,
    9900,
  )
})

test('foreign keys prevent deleting customer, product, order, subscription or actor history', async () => {
  for (const action of [
    () => db.user.delete({ where: { id: customerId } }),
    () => db.user.delete({ where: { id: adminId } }),
    () => db.product.delete({ where: { id: productId } }),
    () => db.order.delete({ where: { id: orderId } }),
    () => db.subscription.delete({ where: { id: subscriptionId } }),
  ])
    await assert.rejects(action(), isPrismaError('P2003'))
})
