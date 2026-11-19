import { Router } from 'express'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { id } from '../users/schemas.ts'
import { orderReadService } from './service.ts'
import {
  listAdminOrders,
  listCustomerOrders,
  orderDetailQuery,
} from './schemas.ts'

// These routers must be mounted behind their respective session + role guards.
export function adminOrderRoutes(database: PrismaClient) {
  const router = Router(),
    service = orderReadService(database)
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
