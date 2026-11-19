import { Router } from 'express'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { id } from '../users/schemas.ts'
import { orderReadService } from './service.ts'
import { orderCreationService } from './create.ts'
import { orderEditService } from './edit.ts'
import { editAdminOrder, editCustomerOrder } from './edit-schemas.ts'
import {
  createAdminOrder,
  createCustomerOrder,
  creationKey,
} from './create-schemas.ts'
import { ApiError } from '../../http/errors.ts'
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

export function customerOrderRoutes(database: PrismaClient) {
  const router = Router(),
    service = orderReadService(database)
  const create = orderCreationService(database)
  const edit = orderEditService(database)
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
