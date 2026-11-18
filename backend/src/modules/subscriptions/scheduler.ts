export function startExpiryScheduler(
  sweep: () => Promise<number>,
  onError: () => void,
) {
  let running: Promise<void> | undefined
  let stopped = false
  const tick = () => {
    if (running || stopped) return
    running = (async () => {
      try {
        while (!stopped && (await sweep()) === 100) {
          /* Drain bounded batches. */
        }
      } catch {
        onError()
      } finally {
        running = undefined
      }
    })()
  }
  const timer = setInterval(tick, 60000)
  timer.unref()
  tick()
  return async () => {
    stopped = true
    clearInterval(timer)
    await running
  }
}
