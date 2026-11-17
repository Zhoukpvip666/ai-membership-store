import type { Customer, Order, Product, Subscription } from '../types'

export function createFixtures(now = new Date()) {
  const at = (offset: number) =>
    new Date(now.getTime() + offset * 86400000).toISOString()
  const products: Product[] = [
    {
      id: 'p1',
      name: 'AI 通用助手 · 月度会员',
      type: 'SUBSCRIPTION',
      priceFen: 12900,
      renewalPriceFen: 11900,
      term: '1 个月',
      listed: true,
      archivedAt: null,
      targetField: 'EMAIL',
    },
    {
      id: 'p2',
      name: 'AI 编程助手 · 月度会员',
      type: 'SUBSCRIPTION',
      priceFen: 9900,
      renewalPriceFen: 8900,
      term: '1 个月',
      listed: true,
      archivedAt: null,
      targetField: 'EMAIL',
    },
    {
      id: 'p3',
      name: 'AI 创作工具 · 年度会员',
      type: 'SUBSCRIPTION',
      priceFen: 59900,
      renewalPriceFen: 55900,
      term: '1 年',
      listed: true,
      archivedAt: null,
      targetField: 'EMAIL',
    },
    {
      id: 'p4',
      name: 'AI 工作流配置服务',
      type: 'ONE_TIME',
      priceFen: 19900,
      renewalPriceFen: null,
      term: '单次服务',
      listed: true,
      archivedAt: null,
      targetField: 'TEXT',
    },
    {
      id: 'p5',
      name: 'AI 工具使用指导',
      type: 'ONE_TIME',
      priceFen: 6900,
      renewalPriceFen: null,
      term: '单次服务',
      listed: true,
      archivedAt: null,
      targetField: 'NONE',
    },
    {
      id: 'p6',
      name: 'AI 效率套件 · 季度会员',
      type: 'SUBSCRIPTION',
      priceFen: 25900,
      renewalPriceFen: 23900,
      term: '3 个月',
      listed: true,
      archivedAt: null,
      targetField: 'EMAIL',
    },
    {
      id: 'p7',
      name: 'AI 阅读助手 · 月度会员',
      type: 'SUBSCRIPTION',
      priceFen: 5900,
      renewalPriceFen: 4900,
      term: '1 个月',
      listed: false,
      archivedAt: null,
      targetField: 'EMAIL',
    },
  ]
  const customers: Customer[] = [
    {
      id: 'u1',
      name: '林小满',
      email: 'lin@example.com',
      createdAt: at(-90),
      active: true,
    },
    {
      id: 'u2',
      name: '陈予',
      email: 'chen@example.com',
      createdAt: at(-62),
      active: true,
    },
    {
      id: 'u3',
      name: '许安',
      email: 'xu@example.com',
      createdAt: at(-21),
      active: false,
    },
  ]
  const seed = [
    ['1008', 'u1', 'p1', 0, 'PENDING', true],
    ['1007', 'u2', 'p4', 0, 'PENDING', true],
    ['1006', 'u1', 'p2', -2, 'COMPLETED', true],
    ['1005', 'u2', 'p5', -3, 'REFUNDED', true],
    ['1004', 'u1', 'p3', -50, 'COMPLETED', true],
    ['1003', 'u1', 'p2', -40, 'COMPLETED', true],
    ['1002', 'u1', 'p7', -3, 'COMPLETED', true],
    ['1001', 'u3', 'p1', -1, 'PENDING', false],
  ] as const
  const orders: Order[] = seed.map(
    ([id, userId, productId, offset, status, paid]) => {
      const product = products.find((p) => p.id === productId)!
      const customer = customers.find((u) => u.id === userId)!
      const createdAt = at(offset)
      return {
        id: 'MOCK-' + id,
        userId,
        productId,
        productName: product.name,
        productType: product.type,
        term: product.term,
        amountFen: product.priceFen,
        contactEmail: customer.email,
        target: customer.email,
        kind: product.type === 'ONE_TIME' ? 'ONE_TIME' : 'INITIAL',
        createdAt,
        verifiedAt: paid ? createdAt : undefined,
        paid,
        status,
        fulfillment:
          status === 'COMPLETED'
            ? 'COMPLETED'
            : status === 'REFUNDED'
              ? 'CANCELLED'
              : paid
                ? 'PROCESSING'
                : 'NOT_STARTED',
        refund: status === 'REFUNDED' ? 'SUCCESS' : 'NONE',
        refundedAt: status === 'REFUNDED' ? createdAt : undefined,
        timeline: [
          { label: '创建模拟订单', at: createdAt },
          ...(paid
            ? [{ label: '模拟收款已确认（演示数据）', at: createdAt }]
            : []),
          ...(status === 'COMPLETED'
            ? [{ label: '模拟服务已完成', at: createdAt }]
            : []),
          ...(status === 'REFUNDED'
            ? [
                {
                  label: '模拟退款成功 · 履约已取消 · 无真实资金变动',
                  at: createdAt,
                },
              ]
            : []),
        ],
      }
    },
  )
  const subscriptions: Subscription[] = [
    {
      id: 'SUB-1001',
      userId: 'u1',
      productId: 'p2',
      productName: products[1]!.name,
      target: 'lin@example.com',
      startedAt: at(-2),
      expiresAt: at(28),
      renewalPriceFen: 8900,
      status: 'ACTIVE',
      orderIds: ['MOCK-1006'],
    },
    {
      id: 'SUB-1002',
      userId: 'u1',
      productId: 'p3',
      productName: products[2]!.name,
      target: 'lin@example.com',
      startedAt: at(-50),
      expiresAt: at(315),
      renewalPriceFen: 55900,
      status: 'ACTIVE',
      orderIds: ['MOCK-1004'],
    },
    {
      id: 'SUB-1003',
      userId: 'u1',
      productId: 'p2',
      productName: products[1]!.name,
      target: 'old@example.com',
      startedAt: at(-40),
      expiresAt: at(-10),
      renewalPriceFen: 8900,
      status: 'EXPIRED',
      orderIds: ['MOCK-1003'],
    },
    {
      id: 'SUB-1004',
      userId: 'u1',
      productId: 'p7',
      productName: products[6]!.name,
      target: 'reading@example.com',
      startedAt: at(-3),
      expiresAt: at(27),
      renewalPriceFen: 4900,
      status: 'ACTIVE',
      orderIds: ['MOCK-1002'],
    },
    {
      id: 'SUB-1005',
      userId: 'u2',
      productId: 'p1',
      productName: products[0]!.name,
      target: 'chen@example.com',
      startedAt: at(-120),
      expiresAt: at(-90),
      renewalPriceFen: 11900,
      status: 'TERMINATED',
      orderIds: [],
    },
  ]
  for (const sub of subscriptions) {
    for (const id of sub.orderIds)
      orders.find((o) => o.id === id)!.subscriptionId = sub.id
  }
  return { products, customers, orders, subscriptions }
}
