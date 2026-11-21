import { Router } from 'express'
import { z } from 'zod'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { id } from '../users/schemas.ts'
import * as schemas from './schemas.ts'
import { subscriptionService } from './service.ts'
import {
  customerSubscriptionReadService,
  listCustomerSubscriptions,
} from './customer-read.ts'

const emptyQuery = z.strictObject({})

export function customerSubscriptionRoutes(database: PrismaClient) {
  const router = Router()
  const service = customerSubscriptionReadService(database)
  router.get('/subscriptions', async (request, response) => {
    response.json(
      await service.list(
        response.locals.principal.user.id,
        listCustomerSubscriptions.parse(request.query),
      ),
    )
  })
  router.get('/subscriptions/:id', async (request, response) => {
    emptyQuery.parse(request.query)
    response.json(
      await service.detail(
        response.locals.principal.user.id,
        id.parse(request.params.id),
      ),
    )
  })
  return router
}

export function subscriptionRoutes(database: PrismaClient) {
  const router = Router()
  const service = subscriptionService(database)
  router.get('/subscriptions', async (request, response) => {
    response.json(
      await service.list(schemas.listSubscriptions.parse(request.query)),
    )
  })
  router.get('/subscriptions/:id', async (request, response) => {
    response.json({
      subscription: await service.detail(id.parse(request.params.id)),
    })
  })
  router.get('/subscriptions/:id/events', async (request, response) => {
    response.json(
      await service.events(
        id.parse(request.params.id),
        schemas.listEvents.parse(request.query),
      ),
    )
  })
  router.post('/subscriptions', async (request, response) => {
    response
      .status(201)
      .json(
        await service.create(
          schemas.createSubscription.parse(request.body),
          response.locals.principal.user.id,
          response.locals.requestId,
          schemas.idempotencyKey.parse(request.get('Idempotency-Key')),
        ),
      )
  })
  router.patch('/subscriptions/:id', async (request, response) => {
    response.json(
      await service.edit(
        id.parse(request.params.id),
        schemas.editSubscription.parse(request.body),
        response.locals.principal.user.id,
        response.locals.requestId,
        schemas.idempotencyKey.parse(request.get('Idempotency-Key')),
      ),
    )
  })
  router.post('/subscriptions/:id/renew', async (request, response) => {
    response.json(
      await service.renew(
        id.parse(request.params.id),
        schemas.renewSubscription.parse(request.body),
        response.locals.principal.user.id,
        response.locals.requestId,
        schemas.idempotencyKey.parse(request.get('Idempotency-Key')),
      ),
    )
  })
  router.post('/subscriptions/:id/terminate', async (request, response) => {
    response.json(
      await service.terminate(
        id.parse(request.params.id),
        schemas.terminateSubscription.parse(request.body),
        response.locals.principal.user.id,
        response.locals.requestId,
        schemas.idempotencyKey.parse(request.get('Idempotency-Key')),
      ),
    )
  })
  return router
}
