import { raw, Router, type Response } from 'express'
import { z } from 'zod'
import { ApiError } from '../../http/errors.ts'
import { maxCoverBytes, productCoverService } from './cover-image.ts'
import type { PrismaClient } from '../../generated/prisma/client.ts'
import { productService } from './service.ts'
import * as products from './schemas.ts'
import { settingsService, editSettings } from '../settings/service.ts'
import { id, emptyBody } from '../users/schemas.ts'
import { catalogDetailQuery, catalogQuery, publicCatalog } from './catalog.ts'

const coverQuery = z.strictObject({
  v: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
})
const uploadBody = raw({
  type: 'application/octet-stream',
  limit: maxCoverBytes,
  inflate: false,
})

function sendCover(response: Response, bytes: Buffer) {
  response
    .set('Cache-Control', 'private, no-store')
    .type('image/webp')
    .send(bytes)
}

export function publicCatalogRoutes(
  database: PrismaClient,
  coverDirectory?: string,
) {
  const router = Router()
  const catalog = publicCatalog(database)
  const covers = productCoverService(database, coverDirectory)
  router.get('/products', async (request, response) => {
    response.json(await catalog.list(catalogQuery.parse(request.query)))
  })
  router.get('/products/:slug/cover-image', async (request, response) => {
    coverQuery.parse(request.query)
    sendCover(response, await covers.readPublic(request.params.slug))
  })
  router.get('/products/:slug', async (request, response) => {
    catalogDetailQuery.parse(request.query)
    response.json(await catalog.detail(request.params.slug))
  })
  return router
}

export function customerPurchaseRoutes(database: PrismaClient) {
  const router = Router()
  const catalog = publicCatalog(database)
  router.get('/products/:slug', async (request, response) => {
    catalogDetailQuery.parse(request.query)
    response.json(await catalog.purchase(request.params.slug))
  })
  return router
}

// Mounted behind the existing /admin session, role, CSRF and mutation-limit guards.
export function productSettingsRoutes(
  database: PrismaClient,
  coverDirectory?: string,
) {
  const router = Router()
  const service = productService(database)
  const settings = settingsService(database)
  const covers = productCoverService(database, coverDirectory)
  const coverPath = '/products/:id/cover-image'
  const actor = (response: Response) => ({
    actorAdminId: response.locals.principal.user.id,
    requestId: response.locals.requestId,
  })
  router.get(coverPath, async (request, response) => {
    coverQuery.parse(request.query)
    sendCover(response, await covers.readAdmin(id.parse(request.params.id)))
  })
  router.put(
    coverPath,
    (request, _response, next) => {
      const encoding = request.get('content-encoding')
      if (encoding && encoding.toLowerCase() !== 'identity')
        throw new ApiError(
          415,
          'UNSUPPORTED_ENCODING',
          '请上传原始图片二进制数据',
        )
      next()
    },
    uploadBody,
    async (request, response) => {
      catalogDetailQuery.parse(request.query)
      response.json(
        await covers.upload(
          id.parse(request.params.id),
          request.body,
          actor(response),
        ),
      )
    },
  )
  router.delete(coverPath, async (request, response) => {
    catalogDetailQuery.parse(request.query)
    emptyBody.parse(request.body)
    response.json(
      await covers.remove(id.parse(request.params.id), actor(response)),
    )
  })
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
