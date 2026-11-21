import { raw, Router } from 'express'
import { z } from 'zod'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { maxQrBytes } from './wechat-image.ts'
import { wechatPaymentService, wechatQrPath } from './wechat-payment.ts'

const emptyQuery = z.strictObject({})
const toggle = z.strictObject({ enabled: z.boolean() })

export function wechatPaymentRoutes(
  db: PrismaClient,
  storageDirectory?: string,
) {
  const router = Router()
  const service = wechatPaymentService(db, storageDirectory)
  router.get('/settings/wechat-payment', async (request, response) => {
    emptyQuery.parse(request.query)
    response.json(await service.get())
  })
  router.patch('/settings/wechat-payment', async (request, response) => {
    emptyQuery.parse(request.query)
    const { enabled } = toggle.parse(request.body)
    response.json(
      await service.setEnabled(enabled, {
        actorAdminId: response.locals.principal.user.id,
        requestId: response.locals.requestId,
      }),
    )
  })
  router.get(wechatQrPath, async (request, response) => {
    emptyQuery.parse(request.query)
    response.type('image/png').send(await service.readImage())
  })
  router.put(
    wechatQrPath,
    raw({
      type: 'application/octet-stream',
      limit: maxQrBytes,
      inflate: false,
    }),
    async (request, response) => {
      emptyQuery.parse(request.query)
      response.json(
        await service.upload(request.body, {
          actorAdminId: response.locals.principal.user.id,
          requestId: response.locals.requestId,
        }),
      )
    },
  )
  return router
}
