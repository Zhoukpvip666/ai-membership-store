import { api } from './client'

export interface PublicProduct {
  slug: string
  name: string
  description: string | null
  type: 'SUBSCRIPTION' | 'ONE_TIME'
  priceFen: number
  renewalPriceFen: number | null
  termLabel: string
  servicePeriodUnit: 'DAY' | 'MONTH' | 'YEAR' | null
  servicePeriodCount: number | null
}

interface CatalogPage {
  items: PublicProduct[]
  total: number
  page: number
  pageSize: number
}

export const readCatalog = (query: URLSearchParams) =>
  api<CatalogPage>('/catalog/products?' + query)

export const readCatalogProduct = (slug: string) =>
  api<PublicProduct>('/catalog/products/' + encodeURIComponent(slug))
