import { api } from './client'
import type { ProductFormSchema } from '../../../backend/src/contracts/product-form'

export type {
  ProductFormSchema,
  FormField,
} from '../../../backend/src/contracts/product-form'
export interface Product {
  id: string
  slug: string
  name: string
  description: string | null
  coverImageUrl: string | null
  type: 'SUBSCRIPTION' | 'ONE_TIME'
  priceFen: number
  renewalPriceFen: number | null
  termLabel: string
  servicePeriodUnit: 'DAY' | 'MONTH' | 'YEAR' | null
  servicePeriodCount: number | null
  targetField: 'EMAIL' | 'TEXT' | 'NONE'
  listed: boolean
  sortOrder: number
  formSchema: ProductFormSchema
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}
export interface ProductList {
  items: Product[]
  total: number
  page: number
  pageSize: number
}
export interface AppSettings {
  id: number
  storeName: string
  ownerEmail: string
  timezone: string
  paymentInstructions: string
  updatedAt: string
}
export const readProducts = (query: URLSearchParams) =>
  api<ProductList>('/admin/products?' + query)

type ProductCoverResult = Pick<Product, 'coverImageUrl' | 'updatedAt'>
const coverPath = (id: string) =>
  '/admin/products/' + encodeURIComponent(id) + '/cover-image'

export const uploadProductCover = (id: string, file: File) =>
  api<ProductCoverResult>(coverPath(id), 'PUT', file)
export const removeProductCover = (id: string) =>
  api<ProductCoverResult>(coverPath(id), 'DELETE', {})
