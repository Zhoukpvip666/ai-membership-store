import { api, apiBlob } from './client'

export interface WechatPaymentSettings {
  enabled: boolean
  imageUrl: string | null
}

export const readWechatPayment = () =>
  api<WechatPaymentSettings>('/admin/settings/wechat-payment')
export const setWechatPayment = (enabled: boolean) =>
  api<WechatPaymentSettings>('/admin/settings/wechat-payment', 'PATCH', {
    enabled,
  })
export const uploadWechatQr = (file: File) =>
  api<WechatPaymentSettings>('/admin/settings/wechat-qr', 'PUT', file)
export const readWechatQr = () => apiBlob('/admin/settings/wechat-qr')
