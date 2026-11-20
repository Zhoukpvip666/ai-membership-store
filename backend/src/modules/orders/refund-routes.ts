import { Router } from 'express'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { id } from '../users/schemas.ts'
import { creationKey } from './create-schemas.ts'
import { orderDetailQuery } from './schemas.ts'
import { offlineRefundService } from './refunds.ts'
import {
  listRefunds,
  recordRefund,
  confirmRefund,
  failRefund,
} from './refund-schemas.ts'

// Mounted exclusively behind persisted ADMIN Session, CSRF and mutation limits.
export function offlineRefundRoutes(database: PrismaClient) {
  const router = Router(),
    service = offlineRefundService(database)
  router.get('/orders/:id/refunds', async (request, response) => {
    response.json(
      await service.list(
        id.parse(request.params.id),
        listRefunds.parse(request.query),
      ),
    )
  })
  router.post('/orders/:id/refunds', async (request, response) => {
    orderDetailQuery.parse(request.query)
    response.status(201).json(
      await service.write(
        {
          operation: 'REFUND_RECORDED',
          id: id.parse(request.params.id),
          input: recordRefund.parse(request.body),
        },
        response.locals.principal.user.id,
        creationKey(request.get('Idempotency-Key')),
        response.locals.requestId,
      ),
    )
  })
  router.post(
    '/payment-transactions/:id/confirm-refund',
    async (request, response) => {
      orderDetailQuery.parse(request.query)
      response.json(
        await service.write(
          {
            operation: 'REFUND_CONFIRMED',
            id: id.parse(request.params.id),
            input: confirmRefund.parse(request.body),
          },
          response.locals.principal.user.id,
          creationKey(request.get('Idempotency-Key')),
          response.locals.requestId,
        ),
      )
    },
  )
  router.post(
    '/payment-transactions/:id/fail-refund',
    async (request, response) => {
      orderDetailQuery.parse(request.query)
      response.json(
        await service.write(
          {
            operation: 'REFUND_FAILED',
            id: id.parse(request.params.id),
            input: failRefund.parse(request.body),
          },
          response.locals.principal.user.id,
          creationKey(request.get('Idempotency-Key')),
          response.locals.requestId,
        ),
      )
    },
  )
  return router
}
