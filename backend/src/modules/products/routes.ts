import { Router } from 'express'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { productService } from './service.ts'
import * as products from './schemas.ts'
import { settingsService, editSettings } from '../settings/service.ts'
import { id, emptyBody } from '../users/schemas.ts'

// Mounted behind the existing /admin session, role, CSRF and mutation-limit guards.
export function productSettingsRoutes(database: PrismaClient) {
  const router = Router()
  const service = productService(database)
  const settings = settingsService(database)
  router.get('/products', async (request, response) => {
    response.json(
      await service.list(products.listProducts.parse(request.query)),
    )
  })
  router.post('/products', async (request, response) => {
    response.status(201).json({
      product: await service.create(
        products.createProduct.parse(request.body),
        response.locals.principal.user.id,
        response.locals.requestId,
      ),
    })
  })
  router.get('/products/:id', async (request, response) => {
    response.json({
      product: await service.detail(id.parse(request.params.id)),
    })
  })
  router.patch('/products/:id', async (request, response) => {
    response.json({
      product: await service.edit(
        id.parse(request.params.id),
        products.editProduct.parse(request.body),
        response.locals.principal.user.id,
        response.locals.requestId,
      ),
    })
  })
  router.post('/products/:id/archive', async (request, response) => {
    emptyBody.parse(request.body)
    response.json({
      product: await service.archive(
        id.parse(request.params.id),
        response.locals.principal.user.id,
        response.locals.requestId,
      ),
    })
  })
  router.get('/settings', async (_request, response) => {
    response.json({ settings: await settings.get() })
  })
  router.patch('/settings', async (request, response) => {
    response.json({
      settings: await settings.edit(
        editSettings.parse(request.body),
        response.locals.principal.user.id,
        response.locals.requestId,
      ),
    })
  })
  return router
}
