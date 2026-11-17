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
  type: 'SUBSCRIPTION' | 'ONE_TIME'
  priceFen: number
  renewalPriceFen: number | null
  termLabel: string
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
  updatedAt: string
}
export const readProducts = (query: URLSearchParams) =>
  api<ProductList>('/admin/products?' + query)
