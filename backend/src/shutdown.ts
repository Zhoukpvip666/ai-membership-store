// Start draining every resource together. Even if one drain fails, wait for
// the others before disconnecting Prisma. Repeated signals share this promise.
export function createGracefulShutdown(
  drains: readonly (() => Promise<void>)[],
  disconnect: () => Promise<void>,
) {
  let pending: Promise<void> | undefined
  return () => (pending ??= drain())

  async function drain() {
    const results = await Promise.allSettled(
      drains.map((stop) => Promise.resolve().then(stop)),
    )
    await disconnect()
    if (results.some((result) => result.status === 'rejected'))
      throw new Error('A service could not drain cleanly.')
  }
}
