import assert from 'node:assert/strict'
import test from 'node:test'
import { createSerialTaskQueue } from './serial-task-queue'

test('runs deferred tasks in enqueue order', async () => {
  const queue = createSerialTaskQueue()
  const calls: string[] = []
  let releaseFirst: () => void = () => undefined
  const waitForRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })

  const first = queue.enqueue(async () => {
    calls.push('first:start')
    await waitForRelease
    calls.push('first:end')
  })
  const second = queue.enqueue(async () => {
    calls.push('second')
  })

  await Promise.resolve()
  assert.deepEqual(calls, ['first:start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(calls, ['first:start', 'first:end', 'second'])
})

test('a failed task does not prevent the next task', async () => {
  const queue = createSerialTaskQueue()
  const calls: string[] = []

  const failed = queue.enqueue(async () => {
    calls.push('failed')
    throw new Error('expected failure')
  })
  const next = queue.enqueue(async () => {
    calls.push('next')
  })

  await assert.rejects(failed, /expected failure/)
  await next
  assert.deepEqual(calls, ['failed', 'next'])
})
