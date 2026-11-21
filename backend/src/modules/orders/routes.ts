import { orderEventService } from './events.ts'
import { orderNoteService } from './internal-note.ts'
import { listOrderEvents, updateInternalNote } from './center-schemas.ts'
import { Router } from 'express'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { id } from '../users/schemas.ts'
import { orderReadService } from './service.ts'
import { orderCreationService } from './create.ts'
import { orderEditService } from './edit.ts'
import { orderCancellationService } from './cancel.ts'
import { offlinePaymentRoutes } from './payment-routes.ts'
import { claimPayment } from './payment-schemas.ts'
import { customerWechatPayment } from './payment-claim.ts'
import { offlineRefundRoutes } from './refund-routes.ts'
import { orderFulfillmentService } from './fulfill.ts'
import { fulfillOrder } from './fulfill-schemas.ts'
import { cancelAdminOrder, cancelCustomerOrder } from './cancel-schemas.ts'
import { editAdminOrder, editCustomerOrder } from './edit-schemas.ts'
import {
  createAdminOrder,
  createCustomerOrder,
  creationKey,
} from './create-schemas.ts'
import { ApiError } from '../../http/errors.ts'
import { settingsService } from '../settings/service.ts'
import {
  listAdminOrders,
  listCustomerOrders,
  orderDetailQuery,
} from './schemas.ts'

// These routers must be mounted behind their respective session + role guards.
export function adminOrderRoutes(database: PrismaClient) {
  const router = Router(),
    service = orderReadService(database)
  const create = orderCreationService(database)
  const edit = orderEditService(database)
  const cancel = orderCancellationService(database)
  router.use(offlinePaymentRoutes(database))
  router.use(offlineRefundRoutes(database))
  const events = orderEventService(database),
    note = orderNoteService(database)
  router.get('/orders/:id/events', async (request, response) => {
    response.json(
      await events(
        id.parse(request.params.id),
        listOrderEvents.parse(request.query),
      ),
    )
  })
  router.patch('/orders/:id/internal-note', async (request, response) => {
    orderDetailQuery.parse(request.query)
    response.json(
      await note(
        id.parse(request.params.id),
        updateInternalNote.parse(request.body),
        response.locals.principal.user.id,
        creationKey(request.get('Idempotency-Key')),
        response.locals.requestId,
      ),
    )
  })
  const fulfill = orderFulfillmentService(database)
  router.post('/orders/:id/fulfill', async (request, response) => {
    orderDetailQuery.parse(request.query)
    response.json(
      await fulfill(
        id.parse(request.params.id),
        fulfillOrder.parse(request.body),
        response.locals.principal.user.id,
        creationKey(request.get('Idempotency-Key')),
        response.locals.requestId,
      ),
    )
  })
  router.post('/orders/:id/cancel', async (request, response) => {
    response.json(
      await cancel(
        'ADMIN',
        cancelAdminOrder.parse(request.body),
        id.parse(request.params.id),
        response.locals.principal.user.id,
        creationKey(request.get('Idempotency-Key')),
        response.locals.requestId,
      ),
    )
  })
  router.patch('/orders/:id', async (request, response) => {
    response.json(
      await edit(
        { role: 'ADMIN', input: editAdminOrder.parse(request.body) },
        id.parse(request.params.id),
        response.locals.principal.user.id,
        creationKey(request.get('Idempotency-Key')),
        response.locals.requestId,
      ),
    )
  })
  router.post('/orders', async (request, response) => {
    response
      .status(201)
      .json(
        await create(
          { role: 'ADMIN', input: createAdminOrder.parse(request.body) },
          response.locals.principal.user.id,
          creationKey(request.get('Idempotency-Key')),
          response.locals.requestId,
        ),
      )
  })
  router.get('/orders', async (request, response) => {
    response.json(await service.listAdmin(listAdminOrders.parse(request.query)))
  })
  router.get('/orders/:id', async (request, response) => {
    orderDetailQuery.parse(request.query)
    response.json({
      order: await service.detailAdmin(id.parse(request.params.id)),
    })
  })
  return router
}

export function customerOrderRoutes(
  database: PrismaClient,
  storageDirectory?: string,
) {
  const router = Router(),
    service = orderReadService(database)
  const create = orderCreationService(database)
  const edit = orderEditService(database)
  const cancel = orderCancellationService(database)
  const settings = settingsService(database)
  const wechat = customerWechatPayment(database, storageDirectory)
  router.get('/orders/:id/wechat-qr', async (request, response) => {
    orderDetailQuery.parse(request.query)
    const bytes = await wechat.image(
      id.parse(request.params.id),
      response.locals.principal.user.id,
    )
    response.type('image/png').send(bytes)
  })
  router.post('/orders/:id/payment-claim', async (request, response) => {
    orderDetailQuery.parse(request.query)
    const { expectedVersion } = claimPayment.parse(request.body)
    response.json(
      await wechat.claim(
        id.parse(request.params.id),
        response.locals.principal.user.id,
        expectedVersion,
        creationKey(request.get('Idempotency-Key')),
      ),
    )
  })
  router.get('/order-guidance', async (request, response) => {
    orderDetailQuery.parse(request.query)
    response.json(await settings.orderGuidance())
  })
  router.post('/orders/:id/cancel', async (request, response) => {
    response.json(
      await cancel(
        'CUSTOMER',
        cancelCustomerOrder.parse(request.body),
        id.parse(request.params.id),
        response.locals.principal.user.id,
        creationKey(request.get('Idempotency-Key')),
        response.locals.requestId,
      ),
    )
  })
  router.patch('/orders/:id', async (request, response) => {
    response.json(
      await edit(
        { role: 'CUSTOMER', input: editCustomerOrder.parse(request.body) },
        id.parse(request.params.id),
        response.locals.principal.user.id,
        creationKey(request.get('Idempotency-Key')),
        response.locals.requestId,
      ),
    )
  })
  router.post('/orders', async (request, response) => {
    const user = response.locals.principal.user
    if (user.status !== 'ACTIVE')
      throw new ApiError(403, 'ACCOUNT_NOT_ELIGIBLE', '账户尚不可下单')
    response
      .status(201)
      .json(
        await create(
          { role: 'CUSTOMER', input: createCustomerOrder.parse(request.body) },
          user.id,
          creationKey(request.get('Idempotency-Key')),
          response.locals.requestId,
        ),
      )
  })
  router.get('/orders', async (request, response) => {
    response.json(
      await service.listCustomer(
        response.locals.principal.user.id,
        listCustomerOrders.parse(request.query),
      ),
    )
  })
  router.get('/orders/:id', async (request, response) => {
    orderDetailQuery.parse(request.query)
    response.json({
      order: await service.detailCustomer(
        response.locals.principal.user.id,
        id.parse(request.params.id),
      ),
    })
  })
  return router
}
