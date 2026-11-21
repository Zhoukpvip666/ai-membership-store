import { api } from './client'
import type {
  FormField,
  ProductFormSchema,
} from '../../../backend/src/contracts/product-form'

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

type CustomerFormField<T extends FormField = FormField> = T extends FormField
  ? Omit<T, 'defaultValue'> & { defaultValue?: never }
  : never

type CustomerFormSchema = Omit<ProductFormSchema, 'fields'> & {
  fields: CustomerFormField[]
}

export interface PurchaseProduct extends PublicProduct {
  id: string
  updatedAt: string
  formSchema: CustomerFormSchema
}

export const readCatalog = (query: URLSearchParams) =>
  api<CatalogPage>('/catalog/products?' + query)

export const readCatalogProduct = (slug: string) =>
  api<PublicProduct>('/catalog/products/' + encodeURIComponent(slug))

export const readPurchaseProduct = (slug: string) =>
  api<PurchaseProduct>('/customer/products/' + encodeURIComponent(slug))
