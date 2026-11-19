import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createDatabase } from '../../src/db/client.ts'
import { Prisma } from '../../src/generated/prisma/client.ts'
import type { Order } from '../../src/generated/prisma/client.ts'
import {
  buildOrderSnapshot,
  orderSnapshotV1,
} from '../../src/modules/orders/revisions.ts'
import { mutation } from '../../src/modules/subscriptions/idempotency.ts'
import { integrationEnvironment } from './support.ts'
import { businessSnapshot } from './order-source-support.ts'

const db = createDatabase(integrationEnvironment().DATABASE_URL)
let adminId: string, customerId: string, productId: string
before(async () => {
  adminId = (await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).id
  customerId = (
    await db.user.create({
      data: { loginEmail: randomUUID() + '@example.com' },
    })
  ).id
  productId = (
    await db.product.create({
      data: {
        slug: randomUUID(),
        name: 'Revision fixture',
        type: 'ONE_TIME',
        priceFen: 100,
        termLabel: 'Display only',
      },
    })
  ).id
})
after(() => db.$disconnect())
const orderInput = () => ({
  orderNo: randomUUID(),
  userId: customerId,
  productId,
  kind: 'ONE_TIME' as const,
  source: 'ADMIN' as const,
  createdByAdminId: adminId,
  productNameSnapshot: 'Original name',
  productDescriptionSnapshot: 'Frozen description',
  productTypeSnapshot: 'ONE_TIME' as const,
  priceSnapshotFen: 100,
  amountFen: 90,
  termSnapshot: 'Unknown display term',
  contactEmailSnapshot: 'contact@example.com',
  formSchemaSnapshot: {
    version: 1,
    fields: [
      { id: 'contact', type: 'text', label: 'Contact', required: false },
    ],
  },
  formData: { contact: 'Non-sensitive account identifier' },
  internalNote: 'Private business note',
})
const fixture = () => db.order.create({ data: orderInput() })
function revision(
  order: Order,
  extra: Partial<Prisma.OrderRevisionUncheckedCreateInput> = {},
) {
  return {
    orderId: order.id,
    version: order.version,
    snapshotSchemaVersion: 1,
    snapshotJson: buildOrderSnapshot(order),
    actorType: 'ADMIN' as const,
    actorUserId: adminId,
    reason: 'Isolated test',
    ...extra,
  }
}
async function snapshot() {
  return {
    ...(await businessSnapshot(db)),
    OrderRevision: await db.orderRevision.findMany({ orderBy: { id: 'asc' } }),
  }
}
async function unchanged(
  operation: () => PromiseLike<unknown>,
  expected: RegExp,
) {
  const before = await snapshot()
  await assert.rejects(Promise.resolve().then(operation), (e: unknown) =>
    expected.test(String(e)),
  )
  assert(
    isDeepStrictEqual(await snapshot(), before),
    'Rejected operation changed business history',
  )
}

test('orders default to V1; INSERT other versions and UPDATE without exactly +1 are rejected by MySQL', async () => {
  const order = await fixture()
  assert.equal(order.version, 1)
  for (const version of [0, -1, 2, 20])
    await unchanged(
      () => db.order.create({ data: { ...orderInput(), version } }),
      /ORDER_INITIAL_VERSION_REQUIRED/,
    )
  for (const version of [0, -1, 1, 3])
    await unchanged(
      () =>
        db.order.update({
          where: { id: order.id },
          data: { internalNote: 'blocked', version },
        }),
      /ORDER_VERSION_MUST_INCREMENT_ONCE/,
    )
  await unchanged(
    () =>
      db.order.update({
        where: { id: order.id },
        data: { internalNote: 'blocked omission' },
      }),
    /ORDER_VERSION_MUST_INCREMENT_ONCE/,
  )
  await unchanged(
    () =>
      db.$executeRaw`UPDATE IGNORE \`Order\` SET version = NULL WHERE id = ${order.id}`,
    /ORDER_VERSION_MUST_INCREMENT_ONCE|version.*null/i,
  )
  await db.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: order.id, version: 1 },
      data: { internalNote: 'accepted', version: { increment: 1 } },
    })
    await tx.orderRevision.create({ data: revision(updated) })
  })
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: order.id } })).version,
    2,
  )
  assert.equal(
    (
      await db.orderRevision.findUniqueOrThrow({
        where: { orderId_version: { orderId: order.id, version: 2 } },
      })
    ).version,
    2,
  )
})

test('USER, ADMIN and nullable SYSTEM actors persist; restrictive order/actor FKs and required human actor are real database constraints', async () => {
  for (const [actorType, actorUserId] of [
    ['USER', customerId],
    ['ADMIN', adminId],
    ['SYSTEM', null],
  ] as const) {
    const order = await fixture()
    const stored = await db.orderRevision.create({
      data: revision(order, { actorType, actorUserId }),
    })
    assert.equal(stored.actorType, actorType)
    assert.equal(stored.actorUserId, actorUserId)
  }
  const order = await fixture()
  for (const actorType of ['USER', 'ADMIN'] as const)
    await unchanged(
      () =>
        db.orderRevision.create({
          data: revision(order, { actorType, actorUserId: null }),
        }),
      /OrderRevision_actor_check/,
    )
  for (const actorType of ['USER', 'ADMIN', 'SYSTEM'] as const)
    await unchanged(
      () =>
        db.orderRevision.create({
          data: revision(order, { actorType, actorUserId: randomUUID() }),
        }),
      /Foreign key constraint/,
    )
  const missingId = randomUUID()
  const missingSnapshot = buildOrderSnapshot({ ...order, id: missingId })
  await unchanged(
    () =>
      db.orderRevision.create({
        data: revision(order, {
          orderId: missingId,
          snapshotJson: missingSnapshot,
        }),
      }),
    /Foreign key constraint/,
  )
  const isolatedActor = await db.user.create({
    data: { loginEmail: randomUUID() + '@example.com' },
  })
  await db.orderRevision.create({
    data: revision(order, { actorType: 'USER', actorUserId: isolatedActor.id }),
  })
  await unchanged(
    () => db.user.delete({ where: { id: isolatedActor.id } }),
    /Foreign key constraint/,
  )
  await unchanged(
    () =>
      db.user.update({
        where: { id: isolatedActor.id },
        data: { id: randomUUID() },
      }),
    /Foreign key constraint/,
  )
})

test('V1 snapshot uses exact versioned business whitelist, preserves JSON/nulls/timestamps, never copies auth or mutable Product', async () => {
  const order = await fixture()
  const value = buildOrderSnapshot({
    ...order,
    passwordHash: 'MUST_NOT_COPY',
    sessionToken: 'MUST_NOT_COPY',
  } as Order)
  assert.deepEqual(Object.keys(value).sort(), [
    'order',
    'snapshotSchemaVersion',
  ])
  assert.deepEqual(
    Object.keys(value.order).sort(),
    [
      'id',
      'orderNo',
      'userId',
      'productId',
      'subscriptionId',
      'kind',
      'source',
      'hidden',
      'productNameSnapshot',
      'productDescriptionSnapshot',
      'productTypeSnapshot',
      'priceSnapshotFen',
      'termSnapshot',
      'servicePeriodUnitSnapshot',
      'servicePeriodCountSnapshot',
      'renewalPeriodStartAt',
      'renewalPeriodEndAt',
      'renewalForPeriodStartAt',
      'billingAnchorSnapshotAt',
      'billingTimezoneSnapshot',
      'billingRevisionSnapshot',
      'formSchemaSnapshot',
      'formData',
      'amountFen',
      'renewalPriceSnapshotFen',
      'contactEmailSnapshot',
      'targetIdentifier',
      'paymentStatus',
      'fulfillmentStatus',
      'paidAt',
      'paymentRecordedAt',
      'paymentConfirmedAt',
      'fulfilledAt',
      'cancelledAt',
      'cancellationReason',
      'internalNote',
      'createdByAdminId',
      'createdByUserId',
      'createdAt',
      'updatedAt',
      'version',
    ].sort(),
  )
  assert(!JSON.stringify(value).includes('MUST_NOT_COPY'))
  assert.equal(value.order.createdAt, order.createdAt.toISOString())
  assert.equal(value.order.servicePeriodUnitSnapshot, null)
  assert.equal(value.order.paidAt, null)
  assert.equal(value.order.internalNote, order.internalNote)
  const stored = await db.orderRevision.create({ data: revision(order) })
  await db.product.update({
    where: { id: productId },
    data: { name: 'Changed catalog name', priceFen: 900 },
  })
  assert.deepEqual(
    (await db.orderRevision.findUniqueOrThrow({ where: { id: stored.id } }))
      .snapshotJson,
    value,
  )
  const reopened = createDatabase(integrationEnvironment().DATABASE_URL)
  try {
    assert.deepEqual(
      (
        await reopened.orderRevision.findUniqueOrThrow({
          where: { id: stored.id },
        })
      ).snapshotJson,
      value,
    )
  } finally {
    await reopened.$disconnect()
  }
})

test('MySQL enforces revision uniqueness, envelope version, identity/version equality, complete allowlist and no extra authentication fields', async () => {
  const order = await fixture(),
    data = revision(order)
  await db.orderRevision.create({ data })
  await unchanged(() => db.orderRevision.create({ data }), /Unique constraint/)
  const other = await fixture(),
    valid = buildOrderSnapshot(other)
  const missing: Record<string, unknown> = { ...valid.order }
  delete missing.internalNote
  assert.equal(
    orderSnapshotV1.safeParse({ ...valid, sessionToken: 'never' }).success,
    false,
  )
  assert.equal(
    orderSnapshotV1.safeParse({
      ...valid,
      order: { ...valid.order, passwordHash: 'never' },
    }).success,
    false,
  )
  const invalid = [
    {},
    { ...valid, sessionToken: 'never' },
    { ...valid, snapshotSchemaVersion: 2 },
    { ...valid, order: { ...valid.order, passwordHash: 'never' } },
    { ...valid, order: missing },
    { ...valid, order: { ...valid.order, id: randomUUID() } },
    { ...valid, order: { ...valid.order, version: 2 } },
    { ...valid, order: { ...valid.order, version: null } },
  ]
  for (const snapshotJson of invalid) {
    await unchanged(
      () =>
        db.orderRevision.create({ data: revision(other, { snapshotJson }) }),
      /OrderRevision_snapshot_check/,
    )
  }
  await unchanged(
    () =>
      db.orderRevision.create({
        data: revision(other, { snapshotSchemaVersion: 2 }),
      }),
    /OrderRevision_(snapshot|version)_check/,
  )
  const future = { ...other, version: 5 }
  await unchanged(
    () => db.orderRevision.create({ data: revision(future) }),
    /ORDER_REVISION_CURRENT_VERSION_REQUIRED/,
  )
})

test('revision UPDATE/DELETE/REPLACE/UPSERT and IGNORE cannot alter history; full related rows remain unchanged', async () => {
  const order = await fixture(),
    stored = await db.orderRevision.create({ data: revision(order) })
  for (const operation of [
    () =>
      db.orderRevision.update({
        where: { id: stored.id },
        data: { reason: 'changed' },
      }),
    () => db.orderRevision.delete({ where: { id: stored.id } }),
    () =>
      db.$executeRaw`UPDATE IGNORE OrderRevision SET reason = 'changed' WHERE id = ${stored.id}`,
    () =>
      db.$executeRaw`DELETE IGNORE FROM OrderRevision WHERE id = ${stored.id}`,
    () =>
      db.$executeRaw`INSERT INTO OrderRevision SELECT * FROM OrderRevision WHERE id = ${stored.id} ON DUPLICATE KEY UPDATE reason = 'changed'`,
    () =>
      db.$executeRaw`REPLACE INTO OrderRevision SELECT * FROM OrderRevision WHERE id = ${stored.id}`,
    () =>
      db.$executeRaw`REPLACE INTO OrderRevision (id,orderId,version,snapshotSchemaVersion,snapshotJson,actorUserId,actorType,reason) SELECT ${randomUUID()},orderId,version,snapshotSchemaVersion,snapshotJson,actorUserId,actorType,'changed' FROM OrderRevision WHERE id = ${stored.id}`,
  ])
    await unchanged(operation, /ORDER_REVISION_IMMUTABLE/)
  const before = await snapshot()
  assert.equal(
    await db.$executeRaw`INSERT IGNORE INTO OrderRevision SELECT * FROM OrderRevision WHERE id = ${stored.id}`,
    0,
  )
  assert(isDeepStrictEqual(await snapshot(), before))
})

test('order, revision, event, audit and idempotency writes all roll back on any failed transaction step', async () => {
  for (const failure of ['revision', 'event', 'audit', 'idempotency']) {
    const before = await snapshot()
    await assert.rejects(
      db.$transaction(async (tx) => {
        const order = await tx.order.create({ data: orderInput() })
        await tx.orderRevision.create({
          data: revision(
            order,
            failure === 'revision' ? { actorUserId: randomUUID() } : {},
          ),
        })
        await tx.orderEvent.create({
          data: {
            orderId: failure === 'event' ? randomUUID() : order.id,
            eventType: 'ORDER_CREATED',
            actorAdminId: adminId,
          },
        })
        await tx.adminAuditLog.create({
          data: {
            actorAdminId: failure === 'audit' ? randomUUID() : adminId,
            action: 'REVISION_ATOMIC_FIXTURE',
            entityType: 'Order',
            entityId: order.id,
          },
        })
        await tx.idempotencyRecord.create({
          data: {
            actorUserId: failure === 'idempotency' ? randomUUID() : adminId,
            keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
            requestHash: 'a'.repeat(64),
            operation: 'ATOMIC_FIXTURE',
            responseJson: { id: order.id },
          },
        })
      }),
      /Foreign key constraint/,
    )
    assert(
      isDeepStrictEqual(await snapshot(), before),
      'Failed transaction left partial records',
    )
  }
})

test('two real concurrent optimistic updates yield one V2 and one revision/event/audit, never duplicate state', async () => {
  const order = await fixture()
  await db.orderRevision.create({ data: revision(order) })
  const update = (note: string) =>
    db.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id: order.id, version: 1 },
        data: { internalNote: note, version: { increment: 1 } },
      })
      if (result.count === 0) return false
      const updated = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
      })
      await tx.orderRevision.create({ data: revision(updated) })
      await tx.orderEvent.create({
        data: { orderId: order.id, eventType: 'NOTE', actorAdminId: adminId },
      })
      await tx.adminAuditLog.create({
        data: {
          actorAdminId: adminId,
          action: 'REVISION_RACE_FIXTURE',
          entityType: 'Order',
          entityId: order.id,
        },
      })
      return true
    })
  const outcomes = await Promise.all([update('left'), update('right')])
  assert.deepEqual(outcomes.sort(), [false, true])
  assert.equal(
    (await db.order.findUniqueOrThrow({ where: { id: order.id } })).version,
    2,
  )
  assert.equal(
    await db.orderRevision.count({ where: { orderId: order.id } }),
    2,
  )
  assert.equal(await db.orderEvent.count({ where: { orderId: order.id } }), 1)
  assert.equal(
    await db.adminAuditLog.count({ where: { entityId: order.id } }),
    1,
  )
})

test('failed update transaction restores the original order/version and all previously appended history', async () => {
  const order = await fixture()
  await db.orderRevision.create({ data: revision(order) })
  const before = await snapshot()
  await assert.rejects(
    db.$transaction(async (tx) => {
      const updated = await tx.order.update({
        where: { id: order.id, version: 1 },
        data: { internalNote: 'rollback update', version: { increment: 1 } },
      })
      await tx.orderRevision.create({ data: revision(updated) })
      await tx.orderEvent.create({
        data: { orderId: order.id, eventType: 'NOTE', actorAdminId: adminId },
      })
      await tx.adminAuditLog.create({
        data: {
          actorAdminId: adminId,
          action: 'REVISION_UPDATE_ROLLBACK',
          entityType: 'Order',
          entityId: order.id,
        },
      })
      throw new Error('fail after every update side effect')
    }),
    /fail after every update side effect/,
  )
  assert(
    isDeepStrictEqual(await snapshot(), before),
    'Update failure consumed a version or left history',
  )
})

test('generic actor+SHA256 key namespace preserves exact canonical replay and separates actors, never stores raw keys', async () => {
  const key = randomUUID(),
    operation = 'GENERIC_FOUNDATION_FIXTURE'
  const result = await mutation(
    db,
    adminId,
    key,
    operation,
    { b: 2, a: { y: 2, x: 1 } },
    async () => ({ committed: 'original' }),
  )
  assert.deepEqual(
    await mutation(
      db,
      adminId,
      key,
      operation,
      { a: { x: 1, y: 2 }, b: 2 },
      async () => {
        throw new Error('replay ran')
      },
    ),
    result,
  )
  assert.deepEqual(
    await mutation(db, customerId, key, operation, { a: 1 }, async () => ({
      customer: true,
    })),
    { customer: true },
  )
  for (const [op, input] of [
    [operation, { a: 2 }],
    ['DIFFERENT_OPERATION', { b: 2, a: { x: 1, y: 2 } }],
  ] as const)
    await assert.rejects(
      mutation(db, adminId, key, op, input, async () => ({})),
      (e: unknown) => (e as { status?: number }).status === 409,
    )
  const rows = await db.idempotencyRecord.findMany({
    where: { keyHash: createHash('sha256').update(key).digest('hex') },
  })
  assert.equal(rows.length, 2)
  assert(!JSON.stringify(rows).includes(key))
  assert(rows.every((row) => /^[a-f0-9]{64}$/.test(row.requestHash)))
})
