import { Router } from 'express'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { id } from '../users/schemas.ts'
import { creationKey } from './create-schemas.ts'
import { offlinePaymentService } from './payments.ts'
import {
  listPayments,
  recordPayment,
  confirmPayment,
  failPayment,
} from './payment-schemas.ts'

// Mounted only behind the existing persisted ADMIN Session/role/CSRF guards.
export function offlinePaymentRoutes(database: PrismaClient) {
  const router = Router(),
    service = offlinePaymentService(database)
  router.get('/orders/:id/payment-transactions', async (request, response) => {
    response.json(
      await service.list(
        id.parse(request.params.id),
        listPayments.parse(request.query),
      ),
    )
  })
  router.post('/orders/:id/payment-transactions', async (request, response) => {
    response.status(201).json(
      await service.write(
        {
          operation: 'PAYMENT_RECORDED',
          id: id.parse(request.params.id),
          input: recordPayment.parse(request.body),
        },
        response.locals.principal.user.id,
        creationKey(request.get('Idempotency-Key')),
        response.locals.requestId,
      ),
    )
  })
  router.post(
    '/payment-transactions/:id/confirm',
    async (request, response) => {
      response.json(
        await service.write(
          {
            operation: 'PAYMENT_CONFIRMED',
            id: id.parse(request.params.id),
            input: confirmPayment.parse(request.body),
          },
          response.locals.principal.user.id,
          creationKey(request.get('Idempotency-Key')),
          response.locals.requestId,
        ),
      )
    },
  )
  router.post('/payment-transactions/:id/fail', async (request, response) => {
    response.json(
      await service.write(
        {
          operation: 'PAYMENT_FAILED',
          id: id.parse(request.params.id),
          input: failPayment.parse(request.body),
        },
        response.locals.principal.user.id,
        creationKey(request.get('Idempotency-Key')),
        response.locals.requestId,
      ),
    )
  })
  return router
}
