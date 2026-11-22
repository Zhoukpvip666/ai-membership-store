import type { UserRole } from '../../generated/prisma/enums.ts'

export type OrderScope =
  { scope: 'management' } | { scope: 'storefront'; actorRole: UserRole }

export type OrderIntent<Self, Managed> =
  | { scope: 'management'; input: Managed }
  | { scope: 'storefront'; actorRole: UserRole; input: Self }

export function orderActorType(access: OrderScope): 'ADMIN' | 'USER' {
  return access.scope === 'management' || access.actorRole === 'ADMIN'
    ? 'ADMIN'
    : 'USER'
}

export function orderOperation(
  access: OrderScope,
  action: 'CREATE' | 'EDIT' | 'CANCEL',
) {
  const prefix =
    access.scope === 'management'
      ? 'ADMIN'
      : access.actorRole === 'ADMIN'
        ? 'ADMIN_SELF'
        : 'CUSTOMER'
  return prefix + '_ORDER_' + action
}
