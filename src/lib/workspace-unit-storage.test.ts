import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWorkspaceUnitCascadeStore,
  createWorkspaceUnitStore,
  type CascadeRunner,
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

interface FakeState {
  settings: unknown
  boqs: Record<string, unknown>
}

function fakeRunner(state: FakeState): CascadeRunner {
  // Mirrors Firestore's transaction invariant: all reads must complete before
  // any write. Once a write begins, further reads throw, so a read-after-write
  // ordering bug fails the test instead of silently passing in-memory. The flag
  // resets per `work` callback, i.e. per transaction.
  return (work) => {
    let writesStarted = false
    return work({
      async readSettings() {
        if (writesStarted) {
          throw new Error('Firestore ordering violated: readSettings after a write')
        }
        return state.settings
      },
      writeSettings(patch) {
        writesStarted = true
        state.settings = { ...((state.settings as object | null) ?? {}), ...patch }
      },
      async readAllBoqs() {
        if (writesStarted) {
          throw new Error('Firestore ordering violated: readAllBoqs after a write')
        }
        return Object.entries(state.boqs).map(([id, data]) => ({ id, data }))
      },
      writeBoq(id, patch) {
        writesStarted = true
        state.boqs[id] = { ...(state.boqs[id] as object), ...patch }
      },
    })
  }
}

test('removeWorkspaceUnitAtomically removes the unit from settings only', async () => {
  const state: FakeState = {
    settings: { units: { customUnits: ['pallet', 'crate'] } },
    boqs: {},
  }
  const store = createWorkspaceUnitCascadeStore(fakeRunner(state))
  const result = await store.remove('crate')
  assert.deepEqual(result.customUnits, ['pallet'])
  assert.deepEqual(
    (state.settings as { units: { customUnits: string[] } }).units.customUnits,
    ['pallet'],
  )
})

test('renameWorkspaceUnitAtomically renames in settings and cascades matching priced items across BOQs', async () => {
  const state: FakeState = {
    settings: { units: { customUnits: ['pallet', 'crate'] } },
    boqs: {
      b1: {
        sections: [
          {
            header: 'A',
            items: [
              { pricingRole: 'standard', unit: 'pallet', desc: 'one' },
              { pricingRole: 'bundle_child', unit: 'pallet', desc: 'child' },
              { pricingRole: 'standard', unit: 'crate', desc: 'two' },
            ],
          },
        ],
      },
      b2: { sections: [{ header: 'B', items: [{ unit: 'm³', desc: 'std' }] }] },
    },
  }
  const store = createWorkspaceUnitCascadeStore(fakeRunner(state))
  const result = await store.rename('pallet', 'PLT')
  assert.deepEqual(result.customUnits, ['PLT', 'crate'])
  assert.equal(result.updatedBoqs, 1)
  assert.equal(result.updatedItems, 1)
  const b1 = state.boqs.b1 as { sections: { items: { unit: string; pricingRole?: string; desc: string }[] }[] }
  assert.equal(b1.sections[0].items[0].unit, 'PLT')
  // bundle_child provenance/row left untouched (not a priced item).
  assert.equal(b1.sections[0].items[1].unit, 'pallet')
  assert.equal(b1.sections[0].items[2].unit, 'crate')
})

test('rename reads all BOQs before any write (Firestore ordering)', async () => {
  // With the ordering-enforcing fakeRunner, a read-after-write bug throws
  // instead of silently passing. This asserts a real rename completes without
  // the ordering throw and still cascades correctly.
  const state: FakeState = {
    settings: { units: { customUnits: ['pallet', 'crate'] } },
    boqs: {
      b1: {
        sections: [
          {
            header: 'A',
            items: [
              { pricingRole: 'standard', unit: 'pallet', desc: 'one' },
              { pricingRole: 'standard', unit: 'crate', desc: 'two' },
            ],
          },
        ],
      },
    },
  }
  const store = createWorkspaceUnitCascadeStore(fakeRunner(state))
  const result = await store.rename('pallet', 'PLT')
  assert.deepEqual(result.customUnits, ['PLT', 'crate'])
  assert.equal(result.updatedBoqs, 1)
  assert.equal(result.updatedItems, 1)
  const b1 = state.boqs.b1 as { sections: { items: { unit: string }[] }[] }
  assert.equal(b1.sections[0].items[0].unit, 'PLT')
  assert.equal(b1.sections[0].items[1].unit, 'crate')
})

test('rename no-op (same value) short-circuits BOQ read/write and returns zero updates', async () => {
  const state: FakeState = {
    settings: { units: { customUnits: ['pallet', 'crate'] } },
    boqs: {
      b1: { sections: [{ items: [{ pricingRole: 'standard', unit: 'pallet' }] }] },
    },
  }
  let boqReads = 0
  let boqWrites = 0
  const runner: CascadeRunner = (work) =>
    work({
      async readSettings() {
        return state.settings
      },
      writeSettings(patch) {
        state.settings = { ...((state.settings as object | null) ?? {}), ...patch }
      },
      async readAllBoqs() {
        boqReads += 1
        return Object.entries(state.boqs).map(([id, data]) => ({ id, data }))
      },
      writeBoq() {
        boqWrites += 1
      },
    })
  const store = createWorkspaceUnitCascadeStore(runner)
  const result = await store.rename('pallet', 'pallet')
  assert.deepEqual(result, { customUnits: ['pallet', 'crate'], updatedBoqs: 0, updatedItems: 0 })
  assert.equal(boqReads, 0)
  assert.equal(boqWrites, 0)
})

test('countWorkspaceUnitUsage counts priced items via the pure helper', async () => {
  const state: FakeState = {
    settings: { units: { customUnits: [] } },
    boqs: {
      b1: { sections: [{ items: [{ pricingRole: 'standard', unit: 'ton' }, { unit: 'ton' }] }] },
    },
  }
  const store = createWorkspaceUnitCascadeStore(fakeRunner(state))
  assert.equal(await store.countUsage('ton'), 2)
  assert.equal(await store.countUsage('absent'), 0)
})
