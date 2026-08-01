# Workspace Units Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Add/Rename/Delete management for workspace custom units as an inline Settings section, with a cascade rename across all BOQs and a block-if-in-use delete.

**Architecture:** Pure helpers in `src/lib/units.ts` (remove/rename/usage); atomic storage in `src/lib/workspace-unit-storage.ts` (transactional remove + cascade rename + usage scan) using injectable transaction adapters for testability; `GET`/`DELETE`/`PATCH` API in `src/app/api/settings/units/`; client fns in `src/lib/workspace-units-client.ts`; a new inline Units section in the Settings page; and a "Manage units…" link in the BOQ Unit combobox.

**Tech Stack:** Next.js 16.2 (App Router), React 19, TypeScript, Firestore (admin), node:test + tsx, 2-space indent.

## Global Constraints

- 2-space indentation; `npm run check` (lint + `tsc --noEmit` + `node --test`) must pass after every task.
- No production migrations; no writes to `sourceUnit` or `sourceCosts.*.unit` provenance fields.
- Standard units (`STANDARD_UNITS` in `src/lib/units.ts`) are always read-only.
- `MAX_CUSTOM_UNITS = 200`, `MAX_UNIT_LENGTH = 24`; reuse `normalizeNewUnit`, `normalizeWorkspaceUnit`, `sanitizeCustomUnits`, `findCanonicalUnit`, `WorkspaceUnitError`.
- All API auth/backend errors return generic non-leaking JSON 500 (existing POST pattern); unauthenticated = 401.
- Workers use model `zai/glm-5.2`. Do not change the Worker model.
- Source-level (string-contract) tests are accepted where SSR cannot render the client page component.

---

## File Structure

- `src/lib/units.ts` — **modify**: add `removeWorkspaceUnit`, `renameWorkspaceUnit`, `mapUnitUsage`, `countUnitUsage`.
- `src/lib/units.test.ts` — **modify**: tests for the new helpers.
- `src/lib/workspace-unit-storage.ts` — **modify**: add `WorkspaceUnitCascadeDocument`, `CascadeRunner`, `createWorkspaceUnitCascadeStore`, `removeWorkspaceUnitAtomically`, `renameWorkspaceUnitAtomically`, `countWorkspaceUnitUsage`.
- `src/lib/workspace-unit-storage.test.ts` — **create**: in-memory cascade adapter tests.
- `src/app/api/settings/units/handler.ts` — **modify**: add `createWorkspaceUnitsGetHandler`, `createWorkspaceUnitsDeleteHandler`, `createWorkspaceUnitsPatchHandler`.
- `src/app/api/settings/units/route.ts` — **modify**: export `GET`, `DELETE`, `PATCH`.
- `src/app/api/settings/units/units-api.test.ts` — **modify**: handler tests for GET/DELETE/PATCH.
- `src/lib/workspace-units-client.ts` — **modify**: add `fetchWorkspaceUnitsOverview`, `removeWorkspaceUnit`, `renameWorkspaceUnit`.
- `src/lib/workspace-units-client.test.ts` — **modify**: client tests.
- `src/app/(authenticated)/settings/page.tsx` — **modify**: add inline Units section.
- `src/app/(authenticated)/settings/settings-units.test.ts` — **create**: source-contract test for the Units section.
- `src/components/unit-combobox.tsx` — **modify**: add "Manage units…" link.
- `src/components/unit-combobox.test.ts` — **modify**: source-contract for the link.

---

## Task 1: Pure helpers — remove, rename, usage

**Files:**
- Modify: `src/lib/units.ts`
- Test: `src/lib/units.test.ts`

**Interfaces:**
- Produces: `removeWorkspaceUnit(existing: readonly string[], unit: string): string[]`; `renameWorkspaceUnit(existing: readonly string[], oldUnit: string, newUnit: string): { customUnits: string[] }`; `mapUnitUsage(boqs: readonly { sections: { items: unknown[] } }[]): Record<string, number>`; `countUnitUsage(boqs, unit): number`. All throw `WorkspaceUnitError` (status 404) for missing source unit; rename reuses `normalizeNewUnit`/`WorkspaceUnitError` (400) for invalid new unit.

- [ ] **Step 1: Write failing tests** in `src/lib/units.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_CUSTOM_UNITS,
  removeWorkspaceUnit,
  renameWorkspaceUnit,
  mapUnitUsage,
  countUnitUsage,
  WorkspaceUnitError,
} from './units'

test('removeWorkspaceUnit drops a custom unit and throws when absent', () => {
  assert.deepEqual(removeWorkspaceUnit(['pallet', 'crate'], 'pallet'), ['crate'])
  assert.deepEqual(removeWorkspaceUnit(['pallet'], 'pallet'), [])
  // Case-sensitive match (canonical casing preserved elsewhere); absent -> 404.
  assert.throws(
    () => removeWorkspaceUnit(['pallet'], 'Pallet'),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 404,
  )
  assert.throws(
    () => removeWorkspaceUnit([], 'pallet'),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 404,
  )
})

test('renameWorkspaceUnit replaces a custom unit in place, validating the new value', () => {
  // In-place replacement preserves order at oldUnit's position.
  assert.deepEqual(
    renameWorkspaceUnit(['pallet', 'crate', 'bag'], 'crate', 'Crate').customUnits,
    ['pallet', 'Crate', 'bag'],
  )
  // newUnit is trimmed.
  assert.deepEqual(
    renameWorkspaceUnit(['pallet'], 'pallet', '  palletX  ').customUnits,
    ['palletX'],
  )
  // oldUnit absent -> 404.
  assert.throws(
    () => renameWorkspaceUnit(['pallet'], 'crate', 'box'),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 404,
  )
  // newUnit empty -> 400.
  assert.throws(
    () => renameWorkspaceUnit(['pallet'], 'pallet', '   '),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 400,
  )
  // newUnit collides with another existing unit -> 400.
  assert.throws(
    () => renameWorkspaceUnit(['pallet', 'crate'], 'pallet', 'crate'),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 400,
  )
  // newUnit over length -> 400.
  assert.throws(
    () => renameWorkspaceUnit(['pallet'], 'pallet', 'x'.repeat(25)),
    (err: unknown) => err instanceof WorkspaceUnitError && err.status === 400,
  )
  // rename to the same canonical value is a no-op-style success (not a collision with self).
  assert.deepEqual(
    renameWorkspaceUnit(['pallet', 'crate'], 'pallet', 'pallet').customUnits,
    ['pallet', 'crate'],
  )
  // newUnit over the cap is still allowed (rename does not grow the list).
  const many = Array.from({ length: MAX_CUSTOM_UNITS }, (_, i) => `u${i}`)
  assert.deepEqual(
    renameWorkspaceUnit(many, 'u0', 'uZero').customUnits.length,
    MAX_CUSTOM_UNITS,
  )
})

test('mapUnitUsage counts priced items by unit and ignores bundle children', () => {
  const boqs = [
    {
      sections: [
        {
          items: [
            { pricingRole: 'standard', unit: 'm³' },
            { pricingRole: 'bundle_parent', unit: 'set' },
            { pricingRole: 'bundle_child', unit: 'kg' }, // ignored
            { unit: 'm³' }, // priced (no pricingRole) -> counted
          ],
        },
      ],
    },
  ] as unknown as Parameters<typeof mapUnitUsage>[0]
  assert.deepEqual(mapUnitUsage(boqs), { 'm³': 2, set: 1 })
})

test('countUnitUsage reads the map for a single unit', () => {
  const boqs = [
    { sections: [{ items: [{ pricingRole: 'standard', unit: 'ton' }, { unit: 'ton' }] }] },
  ] as unknown as Parameters<typeof countUnitUsage>[0]
  assert.equal(countUnitUsage(boqs, 'ton'), 2)
  assert.equal(countUnitUsage(boqs, 'absent'), 0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/units.test.ts`
Expected: FAIL — `removeWorkspaceUnit`/`renameWorkspaceUnit`/`mapUnitUsage`/`countUnitUsage` are not exported.

- [ ] **Step 3: Implement the helpers** in `src/lib/units.ts` (append after `mergeWorkspaceUnit`)

```ts
/** Remove a custom unit. Throws WorkspaceUnitError(404) if it is not present. */
export function removeWorkspaceUnit(
  existing: readonly string[],
  unit: string,
): string[] {
  const customUnits = sanitizeCustomUnits(existing)
  const idx = customUnits.indexOf(unit)
  if (idx === -1) {
    throw new WorkspaceUnitError('Unit is not a custom unit.', 404)
  }
  return [...customUnits.slice(0, idx), ...customUnits.slice(idx + 1)]
}

/** Rename a custom unit in place. oldUnit must exist; newUnit is normalised. */
export function renameWorkspaceUnit(
  existing: readonly string[],
  oldUnit: string,
  newUnit: string,
): { customUnits: string[] } {
  const customUnits = sanitizeCustomUnits(existing)
  const idx = customUnits.indexOf(oldUnit)
  if (idx === -1) {
    throw new WorkspaceUnitError('Unit is not a custom unit.', 404)
  }
  // A rename to the same canonical value is a no-op success.
  if (oldUnit === newUnit.trim()) {
    return { customUnits }
  }
  const others = [...customUnits.slice(0, idx), ...customUnits.slice(idx + 1)]
  const normalised = normalizeNewUnit(newUnit, [...STANDARD_UNITS, ...others])
  if (normalised === null) {
    throw new WorkspaceUnitError('Unit is empty or already exists.', 400)
  }
  return { customUnits: [...customUnits.slice(0, idx), normalised, ...customUnits.slice(idx + 1)] }
}

/**
 * Counts priced BOQ items per unit string. Bundle children
 * (`pricingRole === 'bundle_child'`) are informational and excluded.
 */
export function mapUnitUsage(
  boqs: readonly { sections: { items: readonly unknown[] }[] }[],
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const boq of boqs) {
    for (const section of boq.sections) {
      for (const item of section.items as readonly { pricingRole?: string; unit?: unknown }[]) {
        if (item.pricingRole === 'bundle_child') continue
        if (typeof item.unit !== 'string') continue
        counts[item.unit] = (counts[item.unit] ?? 0) + 1
      }
    }
  }
  return counts
}

/** Single-unit usage count derived from {@link mapUnitUsage}. */
export function countUnitUsage(
  boqs: readonly { sections: { items: readonly unknown[] }[] }[],
  unit: string,
): number {
  return mapUnitUsage(boqs)[unit] ?? 0
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/units.test.ts`
Expected: PASS (all units tests including the new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/units.ts src/lib/units.test.ts
git commit -m "feat(units): add remove/rename/usage helpers"
```

---

## Task 2: Atomic storage — remove, cascade rename, usage scan

**Files:**
- Modify: `src/lib/workspace-unit-storage.ts`
- Create: `src/lib/workspace-unit-storage.test.ts`

**Interfaces:**
- Consumes: `fromStoredSettings`, `StoredWorkspaceSettings`, `WORKSPACE_SETTINGS_ID` from `./settings-storage`; `removeWorkspaceUnit`, `renameWorkspaceUnit`, `mapUnitUsage` from `./units`; `runTransaction` from `./db`; `Boq` type from `./boq-schema`.
- Produces: `removeWorkspaceUnitAtomically(unit: string): Promise<{ customUnits: string[] }>`; `renameWorkspaceUnitAtomically(oldUnit: string, newUnit: string): Promise<{ customUnits: string[]; updatedBoqs: number; updatedItems: number }>`; `countWorkspaceUnitUsage(unit: string): Promise<number>`; plus exported `createWorkspaceUnitCascadeStore(runCascade: CascadeRunner)` and types `WorkspaceUnitCascadeDocument`, `CascadeRunner`.

- [ ] **Step 1: Write failing tests** in `src/lib/workspace-unit-storage.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorkspaceUnitCascadeStore, type CascadeRunner } from './workspace-unit-storage'

interface FakeState {
  settings: unknown
  boqs: Record<string, unknown>
}

function fakeRunner(state: FakeState): CascadeRunner {
  return (work) =>
    work({
      async readSettings() {
        return state.settings
      },
      writeSettings(patch) {
        state.settings = { ...(state.settings as object | null ?? {}), ...patch }
      },
      async readAllBoqs() {
        return Object.entries(state.boqs).map(([id, data]) => ({ id, data }))
      },
      writeBoq(id, patch) {
        state.boqs[id] = { ...state.boqs[id], ...patch }
      },
    })
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/workspace-unit-storage.test.ts`
Expected: FAIL — `createWorkspaceUnitCascadeStore`/`CascadeRunner` not exported.

- [ ] **Step 3: Implement the cascade store** in `src/lib/workspace-unit-storage.ts`

Add the imports `removeWorkspaceUnit`, `renameWorkspaceUnit`, `mapUnitUsage` to the existing `./units` import, add `type Boq` from `./boq-schema`, then append:

```ts
export interface WorkspaceUnitCascadeDocument {
  readSettings(): Promise<unknown | null>
  writeSettings(patch: Record<string, unknown>): void
  readAllBoqs(): Promise<Array<{ id: string; data: unknown }>>
  writeBoq(id: string, patch: Record<string, unknown>): void
}

export type CascadeRunner = <T>(
  work: (document: WorkspaceUnitCascadeDocument) => Promise<T>,
) => Promise<T>

export function createWorkspaceUnitCascadeStore(runCascade: CascadeRunner) {
  return {
    async remove(unit: string) {
      return runCascade(async (document) => {
        const current = fromStoredSettings(
          (await document.readSettings()) as StoredWorkspaceSettings | null,
        )
        const customUnits = removeWorkspaceUnit(current.units.customUnits, unit)
        document.writeSettings({ units: { customUnits } })
        return { customUnits }
      })
    },
    async rename(oldUnit: string, newUnit: string) {
      return runCascade(async (document) => {
        const current = fromStoredSettings(
          (await document.readSettings()) as StoredWorkspaceSettings | null,
        )
        const { customUnits } = renameWorkspaceUnit(current.units.customUnits, oldUnit, newUnit)
        document.writeSettings({ units: { customUnits } })

        const boqs = (await document.readAllBoqs()) as Array<{ id: string; data: Boq }>
        let updatedBoqs = 0
        let updatedItems = 0
        for (const { id, data } of boqs) {
          let touched = false
          const sections = data.sections.map((section) => ({
            ...section,
            items: section.items.map((item) => {
              if (item.pricingRole === 'bundle_child') return item
              if (item.unit === oldUnit) {
                touched = true
                updatedItems += 1
                return { ...item, unit: newUnit.trim() }
              }
              return item
            }),
          }))
          if (touched) {
            updatedBoqs += 1
            document.writeBoq(id, { sections, updatedAt: new Date().toISOString() })
          }
        }
        return { customUnits, updatedBoqs, updatedItems }
      })
    },
    async countUsage(unit: string) {
      return runCascade(async (document) => {
        const boqs = (await document.readAllBoqs()) as Array<{ data: Boq }>
        return mapUnitUsage(boqs.map(({ data }) => data))[unit] ?? 0
      })
    },
  }
}

/**
 * Production cascade runner: settings + all BOQs read/written inside one
 * `runTransaction`. Reads use the transaction for consistency.
 */
const productionCascadeRunner: CascadeRunner = (work) =>
  runTransaction(async (transaction, db) => {
    const settingsRef = db.collection('settings').doc(WORKSPACE_SETTINGS_ID)
    const boqsCollection = db.collection('boqs')
    return work({
      readSettings: async () => {
        const snap = await transaction.get(settingsRef)
        return snap.exists ? snap.data() : null
      },
      writeSettings: (patch) => {
        transaction.set(settingsRef, patch, { merge: true })
      },
      readAllBoqs: async () => {
        const snap = await transaction.get(boqsCollection)
        return snap.docs.map((d) => ({ id: d.id, data: d.data() }))
      },
      writeBoq: (id, patch) => {
        transaction.update(db.collection('boqs').doc(id), patch)
      },
    })
  })

const cascadeStore = createWorkspaceUnitCascadeStore(productionCascadeRunner)

export const removeWorkspaceUnitAtomically = cascadeStore.remove
export const renameWorkspaceUnitAtomically = cascadeStore.rename
export const countWorkspaceUnitUsage = cascadeStore.countUsage
```

Note: `mapUnitUsage` is typed over `{ sections: { items }[] }[]`; `Boq` satisfies this shape. If `transaction.get(collection)` type-checks poorly, cast via `as unknown as Parameters<...>` — keep `tsc` clean.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/workspace-unit-storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace-unit-storage.ts src/lib/workspace-unit-storage.test.ts
git commit -m "feat(units): add atomic remove and cascade rename storage"
```

---

## Task 3: API handlers — GET, DELETE, PATCH

**Files:**
- Modify: `src/app/api/settings/units/handler.ts`
- Modify: `src/app/api/settings/units/route.ts`
- Test: `src/app/api/settings/units/units-api.test.ts`

**Interfaces:**
- Consumes: `WorkspaceUnitError`, `STANDARD_UNITS`, `sanitizeCustomUnits` from `@/lib/units`; `fromStoredSettings`/`StoredWorkspaceSettings` for the GET read; the storage fns `removeWorkspaceUnitAtomically`, `renameWorkspaceUnitAtomically`, `countWorkspaceUnitUsage` from `@/lib/workspace-unit-storage`.
- Produces: `createWorkspaceUnitsGetHandler({ authenticate, readSettings, readAllBoqs })`, `createWorkspaceUnitsDeleteHandler({ authenticate, countUsage, removeUnit })`, `createWorkspaceUnitsPatchHandler({ authenticate, renameUnit })`, each returning an async `(request: Request) => Promise<Response>`.

- [ ] **Step 1: Write failing tests** appended to `src/app/api/settings/units/units-api.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createWorkspaceUnitsGetHandler,
  createWorkspaceUnitsDeleteHandler,
  createWorkspaceUnitsPatchHandler,
} from './handler'

const okAuth = async () => ({ user: { id: '1' } })
const noAuth = async () => null

test('GET returns standard + custom units and per-custom usage', async () => {
  const GET = createWorkspaceUnitsGetHandler({
    authenticate: okAuth,
    readSettings: async () => ({ units: { customUnits: ['pallet', 'crate'] } }),
    readAllBoqs: async () => [
      { id: 'b1', data: { sections: [{ items: [{ pricingRole: 'standard', unit: 'pallet' }] }] } },
    ],
  })
  const res = await GET(new Request('http://x/api/settings/units'))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.standardUnits.includes('m³'))
  assert.deepEqual(body.customUnits, ['pallet', 'crate'])
  assert.deepEqual(body.usage, { pallet: 1, crate: 0 })
})

test('GET rejects unauthenticated with 401', async () => {
  const GET = createWorkspaceUnitsGetHandler({
    authenticate: noAuth,
    readSettings: async () => null,
    readAllBoqs: async () => [],
  })
  const res = await GET(new Request('http://x/api/settings/units'))
  assert.equal(res.status, 401)
})

test('DELETE returns 409 with usageCount when the unit is in use', async () => {
  const DELETE = createWorkspaceUnitsDeleteHandler({
    authenticate: okAuth,
    countUsage: async () => 3,
    removeUnit: async () => ({ customUnits: [] }),
  })
  const res = await DELETE(
    new Request('http://x/api/settings/units', {
      method: 'DELETE',
      body: JSON.stringify({ unit: 'pallet' }),
    }),
  )
  assert.equal(res.status, 409)
  const body = await res.json()
  assert.equal(body.usageCount, 3)
})

test('DELETE removes and returns the custom list when not in use', async () => {
  let removed: string | null = null
  const DELETE = createWorkspaceUnitsDeleteHandler({
    authenticate: okAuth,
    countUsage: async () => 0,
    removeUnit: async (unit: string) => {
      removed = unit
      return { customUnits: ['crate'] }
    },
  })
  const res = await DELETE(
    new Request('http://x/api/settings/units', {
      method: 'DELETE',
      body: JSON.stringify({ unit: 'pallet' }),
    }),
  )
  assert.equal(res.status, 200)
  assert.equal(removed, 'pallet')
  assert.deepEqual((await res.json()).customUnits, ['crate'])
})

test('DELETE rejects malformed body with 400 and unauthenticated with 401', async () => {
  const DELETE = createWorkspaceUnitsDeleteHandler({
    authenticate: okAuth,
    countUsage: async () => 0,
    removeUnit: async () => ({ customUnits: [] }),
  })
  const bad = await DELETE(
    new Request('http://x/api/settings/units', { method: 'DELETE', body: '{}' }),
  )
  assert.equal(bad.status, 400)
  const unauth = createWorkspaceUnitsDeleteHandler({
    authenticate: noAuth,
    countUsage: async () => 0,
    removeUnit: async () => ({ customUnits: [] }),
  })
  assert.equal(
    (await unauth(
      new Request('http://x/api/settings/units', {
        method: 'DELETE',
        body: JSON.stringify({ unit: 'x' }),
      }),
    )).status,
    401,
  )
})

test('PATCH renames and returns the list plus updatedItems', async () => {
  const PATCH = createWorkspaceUnitsPatchHandler({
    authenticate: okAuth,
    renameUnit: async () => ({ customUnits: ['PLT', 'crate'], updatedBoqs: 1, updatedItems: 2 }),
  })
  const res = await PATCH(
    new Request('http://x/api/settings/units', {
      method: 'PATCH',
      body: JSON.stringify({ oldUnit: 'pallet', newUnit: 'PLT' }),
    }),
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body.customUnits, ['PLT', 'crate'])
  assert.equal(body.updatedItems, 2)
})

test('PATCH surfaces a 409 WorkspaceUnitError and rejects malformed body with 400', async () => {
  const { WorkspaceUnitError } = await import('@/lib/units')
  const PATCH = createWorkspaceUnitsPatchHandler({
    authenticate: okAuth,
    renameUnit: async () => {
      throw new WorkspaceUnitError('Unit is not a custom unit.', 404)
    },
  })
  const conflict = await PATCH(
    new Request('http://x/api/settings/units', {
      method: 'PATCH',
      body: JSON.stringify({ oldUnit: 'pallet', newUnit: 'PLT' }),
    }),
  )
  assert.equal(conflict.status, 404)
  const malformed = await PATCH(
    new Request('http://x/api/settings/units', { method: 'PATCH', body: JSON.stringify({}) }),
  )
  assert.equal(malformed.status, 400)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/app/api/settings/units/units-api.test.ts`
Expected: FAIL — the three handler factories are not exported.

- [ ] **Step 3: Implement the handlers** in `src/app/api/settings/units/handler.ts`

Add imports: `STANDARD_UNITS`, `sanitizeCustomUnits`, `WorkspaceUnitError` from `@/lib/units`; `fromStoredSettings`, `type StoredWorkspaceSettings` from `@/lib/settings-storage`. Keep the existing `POST` factory. Append:

```ts
interface WorkspaceUnitsGetDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  readSettings: () => Promise<unknown | null>
  readAllBoqs: () => Promise<Array<{ id: string; data: unknown }>>
}

export function createWorkspaceUnitsGetHandler({
  authenticate,
  readSettings,
  readAllBoqs,
}: WorkspaceUnitsGetDependencies) {
  return async function GET(): Promise<Response> {
    let session
    try {
      session = await authenticate()
    } catch (error) {
      console.error('Error authenticating workspace units overview:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })
    try {
      const settings = fromStoredSettings(
        (await readSettings()) as StoredWorkspaceSettings | null,
      )
      const customUnits = sanitizeCustomUnits(settings.units.customUnits)
      const boqs = await readAllBoqs()
      const usage: Record<string, number> = {}
      const all: Record<string, number> = {}
      for (const { data } of boqs) {
        const sections = (data as { sections?: { items?: unknown[] }[] })?.sections ?? []
        for (const section of sections) {
          for (const item of (section.items ?? []) as readonly { pricingRole?: string; unit?: unknown }[]) {
            if (item.pricingRole === 'bundle_child') continue
            if (typeof item.unit !== 'string') continue
            all[item.unit] = (all[item.unit] ?? 0) + 1
          }
        }
      }
      for (const unit of customUnits) usage[unit] = all[unit] ?? 0
      return Response.json({ standardUnits: [...STANDARD_UNITS], customUnits, usage })
    } catch (error) {
      console.error('Error reading workspace units overview:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}

interface WorkspaceUnitsDeleteDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  countUsage: (unit: string) => Promise<number>
  removeUnit: (unit: string) => Promise<{ customUnits: string[] }>
}

export function createWorkspaceUnitsDeleteHandler({
  authenticate,
  countUsage,
  removeUnit,
}: WorkspaceUnitsDeleteDependencies) {
  return async function DELETE(request: Request): Promise<Response> {
    let session
    try {
      session = await authenticate()
    } catch (error) {
      console.error('Error authenticating workspace unit delete:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      if (error instanceof SyntaxError) {
        return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
      }
      console.error('Error reading workspace unit delete:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (
      typeof body !== 'object' || body === null || Array.isArray(body)
      || Object.keys(body as object).length !== 1
      || (body as { unit?: unknown }).unit === undefined
      || typeof (body as { unit: unknown }).unit !== 'string'
    ) {
      return Response.json({ error: 'Request must contain only unit.' }, { status: 400 })
    }
    const unit = (body as { unit: string }).unit

    try {
      const usageCount = await countUsage(unit)
      if (usageCount > 0) {
        return Response.json(
          { error: 'Unit is in use by existing BOQ items.', usageCount },
          { status: 409 },
        )
      }
      const result = await removeUnit(unit)
      return Response.json({ customUnits: result.customUnits })
    } catch (error) {
      if (error instanceof WorkspaceUnitError) {
        return Response.json({ error: error.message }, { status: error.status })
      }
      console.error('Error deleting workspace unit:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}

interface WorkspaceUnitsPatchDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  renameUnit: (oldUnit: string, newUnit: string) => Promise<{ customUnits: string[]; updatedBoqs: number; updatedItems: number }>
}

export function createWorkspaceUnitsPatchHandler({
  authenticate,
  renameUnit,
}: WorkspaceUnitsPatchDependencies) {
  return async function PATCH(request: Request): Promise<Response> {
    let session
    try {
      session = await authenticate()
    } catch (error) {
      console.error('Error authenticating workspace unit rename:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    if (!session?.user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

    let body: unknown
    try {
      body = await request.json()
    } catch (error) {
      if (error instanceof SyntaxError) {
        return Response.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
      }
      console.error('Error reading workspace unit rename:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
    const obj = body as { oldUnit?: unknown; newUnit?: unknown }
    if (
      typeof body !== 'object' || body === null || Array.isArray(body)
      || typeof obj.oldUnit !== 'string' || typeof obj.newUnit !== 'string'
    ) {
      return Response.json(
        { error: 'Request must contain oldUnit and newUnit.' },
        { status: 400 },
      )
    }

    try {
      const result = await renameUnit(obj.oldUnit, obj.newUnit)
      return Response.json({ customUnits: result.customUnits, updatedItems: result.updatedItems })
    } catch (error) {
      if (error instanceof WorkspaceUnitError) {
        return Response.json({ error: error.message }, { status: error.status })
      }
      console.error('Error renaming workspace unit:', error)
      return Response.json({ error: 'Internal server error' }, { status: 500 })
    }
  }
}
```

- [ ] **Step 4: Wire the routes** in `src/app/api/settings/units/route.ts`

Add imports `getDocument` from `@/lib/db`, `STANDARD_UNITS`/`sanitizeCustomUnits` are not needed in route (handler owns logic), and the storage fns. Then export:

```ts
import { auth } from '@/lib/auth'
import { getDocument } from '@/lib/db'
import {
  removeWorkspaceUnitAtomically,
  renameWorkspaceUnitAtomically,
  countWorkspaceUnitUsage,
} from '@/lib/workspace-unit-storage'
import { WORKSPACE_SETTINGS_ID } from '@/lib/settings-storage'
import { createWorkspaceUnitsPostHandler, createWorkspaceUnitsGetHandler, createWorkspaceUnitsDeleteHandler, createWorkspaceUnitsPatchHandler } from './handler'

export const POST = createWorkspaceUnitsPostHandler({
  authenticate: auth,
  addUnit: addWorkspaceUnitAtomically,
})

export const GET = createWorkspaceUnitsGetHandler({
  authenticate: auth,
  readSettings: () => getDocument('settings', WORKSPACE_SETTINGS_ID),
  readAllBoqs: async () => {
    const db = (await import('@/lib/firebase-admin')).getDb()
    const snap = await db.collection('boqs').get()
    return snap.docs.map((d) => ({ id: d.id, data: d.data() }))
  },
})

export const DELETE = createWorkspaceUnitsDeleteHandler({
  authenticate: auth,
  countUsage: countWorkspaceUnitUsage,
  removeUnit: removeWorkspaceUnitAtomically,
})

export const PATCH = createWorkspaceUnitsPatchHandler({
  authenticate: auth,
  renameUnit: renameWorkspaceUnitAtomically,
})
```

(Keep the existing `addWorkspaceUnitAtomically` import that the POST uses.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsx --test src/app/api/settings/units/units-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/settings/units/handler.ts src/app/api/settings/units/route.ts src/app/api/settings/units/units-api.test.ts
git commit -m "feat(units): add GET/DELETE/PATCH workspace units API"
```

---

## Task 4: Client functions — overview, remove, rename

**Files:**
- Modify: `src/lib/workspace-units-client.ts`
- Test: `src/lib/workspace-units-client.test.ts`

**Interfaces:**
- Produces: `fetchWorkspaceUnitsOverview(fetchImpl?, signal?) => Promise<{ standardUnits: string[]; customUnits: string[]; usage: Record<string, number> }>`; `removeWorkspaceUnit(unit, fetchImpl?) => Promise<{ customUnits: string[] }>` (throws `WorkspaceUnitInUseError` carrying `usageCount` on 409); `renameWorkspaceUnit(oldUnit, newUnit, fetchImpl?) => Promise<{ customUnits: string[]; updatedItems: number }>`.

- [ ] **Step 1: Write failing tests** appended to `src/lib/workspace-units-client.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fetchWorkspaceUnitsOverview,
  removeWorkspaceUnit,
  renameWorkspaceUnit,
  WorkspaceUnitInUseError,
} from './workspace-units-client'

function fakeFetch(map: Record<string, { status?: number; body: unknown }>) {
  return ((url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`
    const entry = map[key]
    if (!entry) throw new Error(`unexpected ${key}`)
    return Promise.resolve(
      new Response(JSON.stringify(entry.body), {
        status: entry.status ?? 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }) as unknown as typeof fetch
}

test('fetchWorkspaceUnitsOverview parses standard/custom/usage', async () => {
  const overview = await fetchWorkspaceUnitsOverview(
    fakeFetch({
      'GET /api/settings/units': {
        body: { standardUnits: ['m³'], customUnits: ['pallet'], usage: { pallet: 2 } },
      },
    }),
  )
  assert.deepEqual(overview, { standardUnits: ['m³'], customUnits: ['pallet'], usage: { pallet: 2 } })
})

test('removeWorkspaceUnit returns the list and surfaces 409 as WorkspaceUnitInUseError', async () => {
  const ok = await removeWorkspaceUnit(
    'crate',
    fakeFetch({ 'DELETE /api/settings/units': { body: { customUnits: ['pallet'] } } }),
  )
  assert.deepEqual(ok.customUnits, ['pallet'])

  await assert.rejects(
    removeWorkspaceUnit(
      'pallet',
      fakeFetch({
        'DELETE /api/settings/units': { status: 409, body: { error: 'in use', usageCount: 4 } },
      }),
    ),
    (err: unknown) => err instanceof WorkspaceUnitInUseError && err.usageCount === 4,
  )
})

test('renameWorkspaceUnit returns the list and updatedItems', async () => {
  const result = await renameWorkspaceUnit(
    'pallet',
    'PLT',
    fakeFetch({
      'PATCH /api/settings/units': {
        body: { customUnits: ['PLT', 'crate'], updatedItems: 2 },
      },
    }),
  )
  assert.deepEqual(result.customUnits, ['PLT', 'crate'])
  assert.equal(result.updatedItems, 2)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/lib/workspace-units-client.test.ts`
Expected: FAIL — the three fns + `WorkspaceUnitInUseError` not exported.

- [ ] **Step 3: Implement the client** in `src/lib/workspace-units-client.ts`

Append (reusing the existing `responseError` for non-409 failures):

```ts
export class WorkspaceUnitInUseError extends Error {
  readonly usageCount: number
  constructor(message: string, usageCount: number) {
    super(message)
    this.name = 'WorkspaceUnitInUseError'
    this.usageCount = usageCount
  }
}

export interface WorkspaceUnitsOverview {
  standardUnits: string[]
  customUnits: string[]
  usage: Record<string, number>
}

export async function fetchWorkspaceUnitsOverview(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WorkspaceUnitsOverview> {
  const response = await fetchImpl('/api/settings/units', { signal })
  if (!response.ok) await responseError(response)
  const body: unknown = await response.json()
  const obj = body as { standardUnits?: unknown; customUnits?: unknown; usage?: unknown }
  if (
    typeof body !== 'object' || body === null || Array.isArray(body)
    || !Array.isArray(obj.standardUnits) || !Array.isArray(obj.customUnits)
    || typeof obj.usage !== 'object' || obj.usage === null
  ) {
    throw new Error('Workspace units overview returned an invalid response.')
  }
  return {
    standardUnits: (obj.standardUnits as unknown[]).filter((u): u is string => typeof u === 'string'),
    customUnits: sanitizeCustomUnits(obj.customUnits),
    usage: obj.usage as Record<string, number>,
  }
}

export async function removeWorkspaceUnit(
  unit: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ customUnits: string[] }> {
  const response = await fetchImpl('/api/settings/units', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unit }),
  })
  if (response.status === 409) {
    let usageCount = 0
    try {
      const body = (await response.json()) as { usageCount?: unknown }
      if (typeof body.usageCount === 'number') usageCount = body.usageCount
    } catch {
      // keep 0
    }
    throw new WorkspaceUnitInUseError('Unit is in use by existing BOQ items.', usageCount)
  }
  if (!response.ok) await responseError(response)
  const body: unknown = await response.json()
  const customUnits = (body as { customUnits?: unknown }).customUnits
  if (!Array.isArray(customUnits)) {
    throw new Error('Workspace units returned an invalid response.')
  }
  return { customUnits: sanitizeCustomUnits(customUnits) }
}

export async function renameWorkspaceUnit(
  oldUnit: string,
  newUnit: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ customUnits: string[]; updatedItems: number }> {
  const response = await fetchImpl('/api/settings/units', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldUnit, newUnit }),
  })
  if (!response.ok) await responseError(response)
  const body: unknown = await response.json()
  const obj = body as { customUnits?: unknown; updatedItems?: unknown }
  if (!Array.isArray(obj.customUnits) || typeof obj.updatedItems !== 'number') {
    throw new Error('Workspace units returned an invalid response.')
  }
  return { customUnits: sanitizeCustomUnits(obj.customUnits), updatedItems: obj.updatedItems }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx tsx --test src/lib/workspace-units-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace-units-client.ts src/lib/workspace-units-client.test.ts
git commit -m "feat(units): add overview/remove/rename client"
```

---

## Task 5: Settings Units section (Add / Rename / Delete UI)

**Files:**
- Modify: `src/app/(authenticated)/settings/page.tsx`
- Create: `src/app/(authenticated)/settings/settings-units.test.ts`

**Interfaces:**
- Consumes: `fetchWorkspaceUnitsOverview`, `addWorkspaceUnit`, `removeWorkspaceUnit`, `renameWorkspaceUnit`, `WorkspaceUnitInUseError` from `@/lib/workspace-units-client`; the existing `AlertDialog` primitives from `@/components/ui/alert-dialog`; existing toast helper (sonner) used elsewhere on the page; existing settings-section `article.proto-card.settings-section` + `settings-section-header`/`settings-section-body` classes.
- Produces: a new `<article data-od-id="workspace-units-settings" id="units">` section after the "Catalog fuzzy rules" section, with: an Add form (`data-od-id="units-add-input"`, `data-od-id="units-add-button"`), the standard units as read-only badges, and the custom units list where each row exposes rename (`data-od-id="units-rename-${unit}"`) and delete (`data-od-id="units-delete-${unit}"`), and a delete confirm `AlertDialog` whose blocked state shows the usage count.

- [ ] **Step 1: Write a failing source-contract test** in `src/app/(authenticated)/settings/settings-units.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'page.tsx'), 'utf8')

test('Settings page renders a workspace-units section with add/rename/delete affordances', () => {
  assert.match(source, /data-od-id="workspace-units-settings"/)
  assert.match(source, /id="units"/)
  assert.match(source, /data-od-id="units-add-input"/)
  assert.match(source, /data-od-id="units-add-button"/)
  // rename + delete are per-custom-unit, keyed by the unit string.
  assert.match(source, /units-rename-/)
  assert.match(source, /units-delete-/)
})

test('Units section is wired to the overview/remove/rename clients', () => {
  assert.match(source, /fetchWorkspaceUnitsOverview/)
  assert.match(source, /removeWorkspaceUnit/)
  assert.match(source, /renameWorkspaceUnit/)
})

test('delete confirm uses AlertDialog and surfaces usage count when in use', () => {
  assert.match(source, /AlertDialog/)
  assert.match(source, /WorkspaceUnitInUseError|usageCount/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/app/(authenticated)/settings/settings-units.test.ts`
Expected: FAIL — no `workspace-units-settings` section in the page.

- [ ] **Step 3: Implement the section** in `src/app/(authenticated)/settings/page.tsx`

Add imports: `fetchWorkspaceUnitsOverview`, `addWorkspaceUnit`, `removeWorkspaceUnit`, `renameWorkspaceUnit`, `WorkspaceUnitInUseError` from `@/lib/workspace-units-client`; `STANDARD_UNITS` from `@/lib/units`. Add component state near the existing section states:

```tsx
const [unitsOverview, setUnitsOverview] = useState<{ customUnits: string[]; usage: Record<string, number> }>({ customUnits: [], usage: {} })
const [unitsLoaded, setUnitsLoaded] = useState(false)
const [unitAddValue, setUnitAddValue] = useState('')
const [unitBusy, setUnitBusy] = useState<string | null>(null)
const [renamingUnit, setRenamingUnit] = useState<string | null>(null)
const [renameValue, setRenameValue] = useState('')
const [deleteTarget, setDeleteTarget] = useState<{ unit: string; usageCount: number | null } | null>(null)
```

Load the overview on mount (alongside the existing mount effect):

```tsx
useEffect(() => {
  let cancelled = false
  fetchWorkspaceUnitsOverview()
    .then((o) => { if (!cancelled) setUnitsOverview({ customUnits: o.customUnits, usage: o.usage }) })
    .catch(() => { /* toast generic error; keep empty list */ })
    .finally(() => { if (!cancelled) setUnitsLoaded(true) })
  return () => { cancelled = true }
}, [])
```

Handlers:

```tsx
async function handleAddUnit() {
  const value = unitAddValue.trim()
  if (!value) return
  setUnitBusy('__add__')
  try {
    const result = await addWorkspaceUnit(value)
    setUnitsOverview((prev) => ({ customUnits: result.customUnits, usage: prev.usage }))
    setUnitAddValue('')
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Could not add unit.')
  } finally {
    setUnitBusy(null)
  }
}

function startRename(unit: string) {
  setRenamingUnit(unit); setRenameValue(unit)
}

async function handleRenameUnit(oldUnit: string) {
  setUnitBusy(oldUnit)
  try {
    const result = await renameWorkspaceUnit(oldUnit, renameValue)
    setUnitsOverview((prev) => ({ customUnits: result.customUnits, usage: prev.usage }))
    setRenamingUnit(null)
    toast.success(`Renamed; updated ${result.updatedItems} item${result.updatedItems === 1 ? '' : 's'}.`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Could not rename unit.')
  } finally {
    setUnitBusy(null)
  }
}

async function handleConfirmDelete() {
  const target = deleteTarget
  if (!target) return
  setUnitBusy(target.unit)
  try {
    const result = await removeWorkspaceUnit(target.unit)
    setUnitsOverview((prev) => ({ customUnits: result.customUnits, usage: prev.usage }))
    setDeleteTarget(null)
  } catch (e) {
    if (e instanceof WorkspaceUnitInUseError) {
      setDeleteTarget({ unit: target.unit, usageCount: e.usageCount })
    } else {
      toast.error(e instanceof Error ? e.message : 'Could not delete unit.')
    }
  } finally {
    setUnitBusy(null)
  }
}
```

Render the section after the Catalog fuzzy rules `<article>`:

```tsx
<article className="proto-card settings-section" data-od-id="workspace-units-settings" id="units">
  <header className="settings-section-header">
    <div>
      <h2>Workspace units</h2>
      <p>Standard units are fixed. Custom units can be renamed (updates all BOQ items) or deleted when not in use.</p>
    </div>
  </header>
  <div className="settings-section-body">
    <div className="proto-field">
      <label htmlFor="units-add-input">Add custom unit</label>
      <div className="settings-actions">
        <input id="units-add-input" className="proto-input" data-od-id="units-add-input" value={unitAddValue} onChange={(e) => setUnitAddValue(e.target.value)} placeholder="e.g. pallet" maxLength={24} />
        <button className="btn btn-primary btn-sm" data-od-id="units-add-button" onClick={handleAddUnit} disabled={unitBusy === '__add__' || unitAddValue.trim() === ''}>Add unit</button>
      </div>
    </div>
    <div className="proto-field">
      <span className="settings-label">Standard units</span>
      <ul className="unit-chips">
        {STANDARD_UNITS.map((u) => <li key={u} className="unit-chip unit-chip-standard">{u}</li>)}
      </ul>
    </div>
    <div className="proto-field">
      <span className="settings-label">Custom units</span>
      {!unitsLoaded ? <p className="meta">Loading…</p> : unitsOverview.customUnits.length === 0 ? <p className="meta">No custom units yet.</p> : (
        <ul className="unit-rows">
          {unitsOverview.customUnits.map((unit) => {
            const usage = unitsOverview.usage[unit] ?? 0
            return (
              <li key={unit} className="unit-row">
                {renamingUnit === unit ? (
                  <>
                    <input className="proto-input" value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={24} aria-label={`Rename ${unit}`} />
                    <button className="btn btn-primary btn-sm" onClick={() => handleRenameUnit(unit)} disabled={unitBusy === unit}>Save</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setRenamingUnit(null)}>Cancel</button>
                  </>
                ) : (
                  <>
                    <span className="unit-row-value">{unit}</span>
                    <span className="unit-row-usage">{usage} item{usage === 1 ? '' : 's'}</span>
                    <button className="btn btn-secondary btn-sm" data-od-id={`units-rename-${unit}`} onClick={() => startRename(unit)} disabled={unitBusy !== null}>Rename</button>
                    <button className="btn btn-outline-danger btn-sm" data-od-id={`units-delete-${unit}`} onClick={() => setDeleteTarget({ unit, usageCount: null })} disabled={unitBusy !== null}>Delete</button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  </div>
</article>
```

And a delete confirm `AlertDialog` rendered once (near the bottom of the page return, sibling to other sections), driven by `deleteTarget`:

```tsx
<AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null) }}>
  <AlertDialogPopup>
    <AlertDialogTitle>Delete unit “{deleteTarget?.unit}”?</AlertDialogTitle>
    <AlertDialogDescription>
      {deleteTarget?.usageCount === null
        ? 'This removes the unit from the workspace picker. BOQ items keep their value until reassigned.'
        : `Cannot delete: ${deleteTarget?.usageCount} item${deleteTarget?.usageCount === 1 ? '' : 's'} use this unit. Reassign them first.`}
    </AlertDialogDescription>
    <div className="settings-actions">
      {deleteTarget?.usageCount === null && (
        <button className="btn btn-danger btn-sm" onClick={handleConfirmDelete} disabled={unitBusy !== null}>Delete</button>
      )}
      <button className="btn btn-secondary btn-sm" onClick={() => setDeleteTarget(null)}>Close</button>
    </div>
  </AlertDialogPopup>
</AlertDialog>
```

Match the exact import names the existing `alert-dialog` module exports (`AlertDialog`, `AlertDialogPopup`, `AlertDialogTitle`, `AlertDialogDescription`); if the page already imports a different subset, reuse those names. If `toast` is not yet imported on this page, import the same sonner `toast` used elsewhere in the app.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/app/(authenticated)/settings/settings-units.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(authenticated)/settings/page.tsx' 'src/app/(authenticated)/settings/settings-units.test.ts'
git commit -m "feat(settings): add workspace units management section"
```

---

## Task 6: BOQ combobox "Manage units…" link

**Files:**
- Modify: `src/components/unit-combobox.tsx`
- Test: `src/components/unit-combobox.test.ts`

**Interfaces:**
- Produces: a navigational "Manage units…" control below the existing "Add workspace unit" affordance inside the combobox dropdown, linking to `/settings#units` and closing the combobox on click.

- [ ] **Step 1: Write a failing source-contract test** appended to `src/components/unit-combobox.test.ts`

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, 'unit-combobox.tsx'), 'utf8')

test('unit combobox offers a Manage units link to the settings anchor', () => {
  assert.match(source, /Manage units/)
  assert.match(source, /\/settings#units/)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test src/components/unit-combobox.test.ts`
Expected: FAIL — no "Manage units" / `/settings#units`.

- [ ] **Step 3: Add the link** in `src/components/unit-combobox.tsx`

Below the existing "Add workspace unit" affordance (around the line with `Add workspace unit`), add a Next.js `<Link>` (import `Link` from `next/link` if not already imported) that closes the combobox on click:

```tsx
<Link
  href="/settings#units"
  className="unit-combobox-manage"
  onClick={() => setOpen(false)}
>
  Manage units…
</Link>
```

Place it so it renders within the open dropdown (inside the same popup container as the "Add workspace unit" button). Use the project's existing `setOpen` state that controls combobox open/close.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx --test src/components/unit-combobox.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/unit-combobox.tsx src/components/unit-combobox.test.ts
git commit -m "feat(boq): add Manage units link to unit combobox"
```

---

## Final verification

- [ ] Run `npm run check` — lint + `tsc --noEmit` + all tests must pass.
- [ ] Restore any unstaged tracked formatter drift to `HEAD` before review.
- [ ] Run `graphify update .`.
- [ ] Whole-branch review via `superpowers:requesting-code-review`, then `superpowers:finishing-a-development-branch`.
