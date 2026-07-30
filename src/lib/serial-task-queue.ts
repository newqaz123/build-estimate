export interface SerialTaskQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>
}

export function createSerialTaskQueue(): SerialTaskQueue {
  let tail: Promise<void> = Promise.resolve()

  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const running = tail.then(task)
      tail = running.then(
        () => undefined,
        () => undefined,
      )
      return running
    },
  }
}
