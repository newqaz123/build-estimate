import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWorkspaceUnitStore,
  type WorkspaceSettingsTransactionRunner,
} from './workspace-unit-storage'

function memoryRunner() {
  let stored: Record<string, unknown> | null = null
  let tail = Promise.resolve()

  const run: WorkspaceSettingsTransactionRunner = async (work) => {
    let release: () => void = () => undefined
    const previous = tail
    tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    let patch: Record<string, unknown> | null = null
    try {
      const result = await work({
        read: async () => stored,
        write: (value) => {
          patch = value
        },
      })
      if (patch) {
        // `patch` is assigned inside a closure that runs before this point,
        // so TS control-flow analysis keeps its declared nullable type here.
        const merge = patch as Record<string, unknown>
        stored = { ...(stored ?? {}), ...merge }
      }
      return result
    } finally {
      release()
    }
  }

  return { run, read: () => stored }
}

test('concurrent additions retain both units', async () => {
  const memory = memoryRunner()
  const store = createWorkspaceUnitStore(memory.run)

  await Promise.all([store.add('bag'), store.add('drum')])

  assert.deepEqual(
    (memory.read()?.units as { customUnits: string[] }).customUnits,
    ['bag', 'drum'],
  )
})

test('duplicate additions are idempotent', async () => {
  const memory = memoryRunner()
  const store = createWorkspaceUnitStore(memory.run)

  assert.equal((await store.add('Bag')).added, true)
  assert.deepEqual(await store.add(' bag '), {
    unit: 'Bag',
    customUnits: ['Bag'],
    added: false,
  })
})
