# BOQ Detail Controls Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a portaled searchable Unit combobox with workspace-wide units, stable identity-keyed local drafts, non-blocking actions, safe deferred deletion, a sticky delete rail, and explicit saved-version approval.

**Architecture:** Add normalized workspace-unit settings with an atomic Firestore transaction and a thin authenticated Route Handler. Keep BOQ edits client-local and keyed only by stable item identity; resolve current locations immediately before save or delete mutations. Use Base UI primitives for the portaled combobox, tooltip, and alert-dialog semantics, while the page owns persistence, draft reconciliation, delete queuing, and action-specific busy state.

**Tech Stack:** Next.js 16.2 App Router, React 19 client components, TypeScript, Base UI 1.6, Firestore transactions, Sonner, lucide-react, CSS design tokens, `node:test` through `tsx --test`.

## Global Constraints

- Authoritative design: `docs/superpowers/specs/2026-07-30-boq-detail-controls-refinement-design.md`.
- Create the implementation worktree with `superpowers:using-git-worktrees` before Task 1; never implement on `main`.
- Use one fresh Worker per task. After every task commit, stop and dispatch a fresh Reviewer before starting the next task.
- After all tasks, run fresh whole-branch reviewers for correctness/regressions, tests/validation, and UI/accessibility.
- Preserve the table order: Description, Unit, Qty, Rate, Material, Labour, Total, Catalog, delete rail.
- Rate remains calculated and read-only. Qty remains a spinner-less editable decimal text input.
- Do not modify `CatalogMatchModal`, `src/components/ui/dialog.tsx`, or catalog-dialog positioning.
- Do not add a Settings management screen.
- Unit names are trimmed, at most 24 characters, reject control characters, deduplicate case-insensitively, preserve first casing/insertion order, and cap custom units at 200.
- Adding a workspace-unit definition persists immediately; selecting it in a BOQ remains a local draft until **Save draft**.
- Draft keys must use `getBoqItemIdentityKey(item)` only. Never use section/item positions as draft-key fallback.
- Keep the six-second delete Undo window and Sonner’s shared idempotent `onAutoClose`/`onDismiss` finalizer.
- Approval with drafts sends only `{ status: "approved" }`, clears drafts only after success, and preserves drafts on failure.
- Follow 2-space indentation.
- Quote or escape every shell path containing `[id]`.
- Run `npm run check`; do not run production migrations.
- Read and follow:
  - `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`
  - `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`
- Route Handler notes for Next.js 16.2:
  - Route Handlers live in `app/**/route.ts`.
  - `POST` is supported and uncached.
  - Native `Request`/`Response` APIs are valid.
- Client-component notes:
  - Keep `"use client"` above imports in interactive components.
  - Database/authentication code must remain server-side behind the Route Handler.
- The test harness has no jsdom. Use pure-function tests, SSR markup tests, focused source-contract tests, and browser QA. Source-level tests are accepted for `src/app/(authenticated)/boqs/[id]/page.tsx`.

## Execution and Review Contract

After each task:

1. The Worker runs the listed focused tests.
2. The Worker commits only that task.
3. A fresh Reviewer inspects the commit and focused validation.
4. Any accepted findings go to a fresh fix Worker.
5. The task’s focused tests are rerun before proceeding.

Do not combine task commits or allow later tasks to mask an earlier task’s failing reviewer gate.

---

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/lib/settings-schema.ts` | Add `UnitSettings` to `WorkspaceSettings` | 1 |
| `src/lib/settings-storage.ts` | Central defaults and safe stored-settings codecs, including legacy unit defaults | 1 |
| `src/lib/settings-storage.test.ts` | Legacy/malformed settings decoding tests | 1 |
| `src/app/api/settings/route.ts` | Consume shared settings codecs; GET returns defaults without storage initialization | 1 |
| `src/app/api/settings/settings-api.test.ts` | Source contract preventing GET from racing atomic unit writes | 1 |
| `src/lib/units.ts` | Workspace-unit normalization, deduplication, limits, and option combination | 1 |
| `src/lib/units.test.ts` | Pure workspace-unit rules | 1 |
| `src/lib/workspace-unit-storage.ts` | Atomic transactional addition of one custom unit | 2 |
| `src/lib/workspace-unit-storage.test.ts` | Idempotency, cap, and concurrent-add tests | 2 |
| `src/app/api/settings/units/handler.ts` | Dependency-injected authenticated POST handler | 2 |
| `src/app/api/settings/units/route.ts` | Next.js Route Handler adapter | 2 |
| `src/app/api/settings/units/units-api.test.ts` | Auth, request, response, and error mapping tests | 2 |
| `src/lib/workspace-units-client.ts` | Typed GET/POST client helpers | 2 |
| `src/lib/workspace-units-client.test.ts` | Client response/error tests | 2 |
| `src/components/unit-combobox.tsx` | Base UI portaled combobox and inline add state | 3 |
| `src/components/unit-combobox.test.ts` | SSR and source-contract combobox tests | 3 |
| `src/app/globals.css` | Combobox, sticky rail, tooltip, unsaved status, responsive and reduced-motion styles | 3, 6, 7 |
| `src/lib/boq-item-identity.ts` | Resolve a stable identity globally to its current BOQ location | 4 |
| `src/lib/boq-item-identity.test.ts` | Missing, moved, duplicate, and current-location tests | 4 |
| `src/lib/boq-detail-state.ts` | Apply, resolve, reconcile, stash, and restore identity-keyed drafts | 4 |
| `src/lib/boq-detail-state.test.ts` | Stable draft and reconciliation tests | 4 |
| `src/lib/boq-unified-rows.ts` | Expose stable identity and identity problems on unified rows | 4 |
| `src/lib/boq-unified-rows.test.ts` | Unique/missing/ambiguous row identity tests | 4 |
| `src/components/unified-boq-items-table.tsx` | Action-specific locks, async unit persistence, row identity errors, full column contract | 5, 6 |
| `src/components/unified-boq-items-table.test.ts` | Full columns, action availability, sticky rail and responsive contracts | 5, 6 |
| `src/app/(authenticated)/boqs/[id]/page.tsx` | Workspace units, stable drafts, action states, delete queue, approval warning | 5–7 |
| `src/app/(authenticated)/boqs/[id]/page.test.ts` | Source-level state-flow regression tests | 5–7 |
| `src/lib/serial-task-queue.ts` | Failure-tolerant serialized promise queue | 6 |
| `src/lib/serial-task-queue.test.ts` | Ordering and failure recovery tests | 6 |
| `src/components/ui/alert-dialog.tsx` | Styled Base UI alert-dialog primitives | 7 |
| `docs/superpowers/specs/2026-07-30-boq-detail-controls-refinement-design.md` | Approved acceptance source; no implementation edits expected | Reference |

## Files to Modify

- `src/lib/settings-schema.ts` — add workspace units.
- `src/lib/settings-storage.ts` — centralize defaults/codecs.
- `src/lib/settings-storage.test.ts` — verify legacy defaults.
- `src/app/api/settings/route.ts` — use shared codecs.
- `src/lib/units.ts` and `src/lib/units.test.ts` — add validated workspace-unit behavior.
- `src/components/unit-combobox.tsx` and test — portaled accessible redesign.
- `src/lib/boq-item-identity.ts` and test — global current-location resolution.
- `src/lib/boq-detail-state.ts` and test — stable draft operations.
- `src/lib/boq-unified-rows.ts` and test — identity status on rows.
- `src/components/unified-boq-items-table.tsx` and test — action-specific controls and sticky rail.
- `src/app/(authenticated)/boqs/[id]/page.tsx` and test — integrate persistence and state flows.
- `src/app/globals.css` — approved visual and responsive treatment.

## New Files

- `src/app/api/settings/settings-api.test.ts`
- `src/lib/workspace-unit-storage.ts`
- `src/lib/workspace-unit-storage.test.ts`
- `src/app/api/settings/units/handler.ts`
- `src/app/api/settings/units/route.ts`
- `src/app/api/settings/units/units-api.test.ts`
- `src/lib/workspace-units-client.ts`
- `src/lib/workspace-units-client.test.ts`
- `src/lib/serial-task-queue.ts`
- `src/lib/serial-task-queue.test.ts`
- `src/components/ui/alert-dialog.tsx`

---

## Tasks

### Task 1: Workspace-unit domain and settings compatibility

**Files:**

- Modify: `src/lib/settings-schema.ts`
- Modify: `src/lib/settings-storage.ts`
- Modify: `src/lib/settings-storage.test.ts`
- Modify: `src/app/api/settings/route.ts`
- Create: `src/app/api/settings/settings-api.test.ts`
- Modify: `src/lib/units.ts`
- Modify: `src/lib/units.test.ts`

**Interfaces:**

- Produces:
  - `UnitSettings`
  - `WorkspaceSettings.units`
  - `WORKSPACE_SETTINGS_ID`
  - `DEFAULT_SETTINGS`
  - `StoredWorkspaceSettings`
  - `fromStoredSettings(value)`
  - `toStoredSettings(settings)`
  - `MAX_CUSTOM_UNITS`
  - `MAX_UNIT_LENGTH`
  - `WorkspaceUnitError`
  - `WorkspaceUnitMergeResult`
  - `normalizeWorkspaceUnit(raw)`
  - `sanitizeCustomUnits(raw)`
  - `findCanonicalUnit(units, raw)`
  - `combineUnitOptions(customUnits)`
  - `mergeWorkspaceUnit(customUnits, raw)`
- Consumed by Tasks 2, 3, and 5.

- [ ] **Step 1: Add failing normalization and legacy-settings tests**

Extend `src/lib/units.test.ts`:

```ts
import {
  MAX_CUSTOM_UNITS,
  WorkspaceUnitError,
  combineUnitOptions,
  mergeWorkspaceUnit,
  normalizeWorkspaceUnit,
} from './units'

test('workspace units trim, reject control characters, and enforce 24 characters', () => {
  assert.equal(normalizeWorkspaceUnit('  bag  '), 'bag')
  assert.throws(
    () => normalizeWorkspaceUnit('bad\u0000unit'),
    (error: unknown) => error instanceof WorkspaceUnitError && error.status === 400,
  )
  assert.throws(
    () => normalizeWorkspaceUnit('x'.repeat(25)),
    (error: unknown) => error instanceof WorkspaceUnitError && error.status === 400,
  )
})

test('workspace units preserve canonical casing and insertion order', () => {
  const first = mergeWorkspaceUnit([], 'Bag')
  const duplicate = mergeWorkspaceUnit(first.customUnits, ' bag ')
  const second = mergeWorkspaceUnit(duplicate.customUnits, 'drum')

  assert.deepEqual(second.customUnits, ['Bag', 'drum'])
  assert.deepEqual(duplicate, {
    unit: 'Bag',
    customUnits: ['Bag'],
    added: false,
  })
  assert.deepEqual(combineUnitOptions(['Bag', 'bag', 'm³']), [
    ...STANDARD_UNITS,
    'Bag',
  ])
})

test('a new unit beyond the 200-unit cap returns conflict but duplicates remain idempotent', () => {
  const full = Array.from({ length: MAX_CUSTOM_UNITS }, (_, index) => `u${index}`)
  assert.equal(mergeWorkspaceUnit(full, 'U0').added, false)
  assert.throws(
    () => mergeWorkspaceUnit(full, 'overflow'),
    (error: unknown) => error instanceof WorkspaceUnitError && error.status === 409,
  )
})
```

Extend `src/lib/settings-storage.test.ts`:

```ts
import {
  DEFAULT_SETTINGS,
  fromStoredSettings,
  toStoredSettings,
} from './settings-storage'

test('older workspace settings default to an empty custom-unit list', () => {
  const decoded = fromStoredSettings({
    llm: DEFAULT_SETTINGS.llm,
    docling: DEFAULT_SETTINGS.docling,
    fuzzy: {
      unitMap: {},
      normalizeRules: [],
    },
    prompts: DEFAULT_SETTINGS.prompts,
  })

  assert.deepEqual(decoded.units, { customUnits: [] })
})

test('stored custom units are sanitized without changing their first casing or order', () => {
  const decoded = fromStoredSettings({
    units: { customUnits: [' Bag ', 'bag', 'drum', 'bad\u0000unit'] },
  })

  assert.deepEqual(decoded.units.customUnits, ['Bag', 'drum'])
  assert.deepEqual(
    toStoredSettings(decoded).units,
    { customUnits: ['Bag', 'drum'] },
  )
})
```

Create `src/app/api/settings/settings-api.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./route.ts', import.meta.url), 'utf8')
const getSource = source.slice(
  source.indexOf('export async function GET'),
  source.indexOf('export async function PUT'),
)

test('settings GET returns defaults without writing a missing document', () => {
  assert.match(getSource, /return NextResponse\.json\(DEFAULT_SETTINGS\)/)
  assert.doesNotMatch(getSource, /setDocument/)
})
```

- [ ] **Step 2: Verify the new tests fail**

Run:

```bash
npx tsx --test src/lib/units.test.ts src/lib/settings-storage.test.ts src/app/api/settings/settings-api.test.ts
```

Expected: FAIL because the unit settings/helpers do not exist and GET still writes the missing document.

- [ ] **Step 3: Add the settings and unit interfaces**

In `src/lib/settings-schema.ts`:

```ts
export interface UnitSettings {
  customUnits: string[]
}

export interface WorkspaceSettings {
  llm: LlmSettings
  docling: DoclingSettings
  fuzzy: FuzzySettings
  prompts: PromptSettings
  units: UnitSettings
}
```

In `src/lib/units.ts`, retain `STANDARD_UNITS`, `filterUnits`, and `normalizeNewUnit`, then add:

```ts
export const MAX_CUSTOM_UNITS = 200
export const MAX_UNIT_LENGTH = 24

export class WorkspaceUnitError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message)
    this.name = 'WorkspaceUnitError'
  }
}

export interface WorkspaceUnitMergeResult {
  unit: string
  customUnits: string[]
  added: boolean
}

export function normalizeWorkspaceUnit(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new WorkspaceUnitError('Unit must be a string.', 400)
  }
  const unit = raw.trim()
  if (!unit) throw new WorkspaceUnitError('Unit is required.', 400)
  if (unit.length > MAX_UNIT_LENGTH) {
    throw new WorkspaceUnitError(`Unit must be ${MAX_UNIT_LENGTH} characters or fewer.`, 400)
  }
  if (/[\u0000-\u001F\u007F]/.test(unit)) {
    throw new WorkspaceUnitError('Unit cannot contain control characters.', 400)
  }
  return unit
}

export function findCanonicalUnit(
  units: readonly string[],
  raw: string,
): string | undefined {
  const key = raw.toLowerCase()
  return units.find((unit) => unit.toLowerCase() === key)
}

export function sanitizeCustomUnits(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const result: string[] = []
  for (const value of raw) {
    try {
      const unit = normalizeWorkspaceUnit(value)
      if (!findCanonicalUnit([...STANDARD_UNITS, ...result], unit)) result.push(unit)
    } catch {
      continue
    }
    if (result.length === MAX_CUSTOM_UNITS) break
  }
  return result
}

export function combineUnitOptions(customUnits: unknown): string[] {
  return [...STANDARD_UNITS, ...sanitizeCustomUnits(customUnits)]
}

export function mergeWorkspaceUnit(
  current: readonly string[],
  raw: unknown,
): WorkspaceUnitMergeResult {
  const customUnits = sanitizeCustomUnits(current)
  const unit = normalizeWorkspaceUnit(raw)
  const canonical = findCanonicalUnit([...STANDARD_UNITS, ...customUnits], unit)
  if (canonical) return { unit: canonical, customUnits, added: false }
  if (customUnits.length >= MAX_CUSTOM_UNITS) {
    throw new WorkspaceUnitError('Workspace unit limit reached.', 409)
  }
  return {
    unit,
    customUnits: [...customUnits, unit],
    added: true,
  }
}
```

- [ ] **Step 4: Centralize settings defaults and codecs**

Move `DEFAULT_SETTINGS`, `StoredWorkspaceSettings`, `toStoredSettings`, and `fromStoredSettings` from `src/app/api/settings/route.ts` into `src/lib/settings-storage.ts`.

Use these exported shapes:

```ts
export const WORKSPACE_SETTINGS_ID = 'workspace'

export const DEFAULT_SETTINGS: WorkspaceSettings = {
  llm: { provider: 'openai', model: 'gpt-4o' },
  docling: { endpoint: 'http://localhost:5001' },
  fuzzy: {
    unitMap: { LS: 'L/S', SQFT: 'sq ft', SQM: 'sq m' },
    normalizeRules: [
      ['\\bsq\\.?\\s*ft\\b', 'sq ft'],
      ['\\bsq\\.?\\s*m\\b', 'sq m'],
    ],
  },
  prompts: withPromptDefaults(),
  units: { customUnits: [] },
}

export interface StoredWorkspaceSettings {
  llm?: LlmSettings
  docling?: DoclingSettings
  fuzzy?: Omit<FuzzySettings, 'normalizeRules'> & {
    normalizeRules?: unknown
  }
  prompts?: Partial<PromptSettings>
  units?: { customUnits?: unknown }
}

export function fromStoredSettings(
  stored: StoredWorkspaceSettings | null | undefined,
): WorkspaceSettings {
  return {
    llm: stored?.llm ?? DEFAULT_SETTINGS.llm,
    docling: stored?.docling ?? DEFAULT_SETTINGS.docling,
    fuzzy: stored?.fuzzy
      ? {
          unitMap: stored.fuzzy.unitMap ?? DEFAULT_SETTINGS.fuzzy.unitMap,
          normalizeRules: decodeNormalizeRules(
            stored.fuzzy.normalizeRules,
            DEFAULT_SETTINGS.fuzzy.normalizeRules,
          ),
        }
      : DEFAULT_SETTINGS.fuzzy,
    prompts: withPromptDefaults(stored?.prompts),
    units: {
      customUnits: sanitizeCustomUnits(stored?.units?.customUnits),
    },
  }
}
```

`toStoredSettings` must continue encoding `normalizeRules` as `{ find, replace }` records and must include the normalized `units` section.

Update `src/app/api/settings/route.ts` to import these exports. Keep existing GET/PUT authentication and the existing PUT section whitelist unchanged; the new unit list is written only through Task 2’s atomic endpoint. When GET finds no settings document, return `DEFAULT_SETTINGS` without writing it. Remove the now-unused `setDocument` import from the GET path. A read endpoint must not race a concurrent atomic unit addition by writing `units.customUnits: []` after its missing-document check.

- [ ] **Step 5: Run focused tests and type checking**

Run:

```bash
npx tsx --test src/lib/units.test.ts src/lib/settings-storage.test.ts src/app/api/settings/settings-api.test.ts
npx tsc --noEmit
```

Expected: all tests PASS and TypeScript reports no missing `WorkspaceSettings.units` fixture errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings-schema.ts src/lib/settings-storage.ts src/lib/settings-storage.test.ts src/lib/units.ts src/lib/units.test.ts src/app/api/settings/route.ts src/app/api/settings/settings-api.test.ts
git commit -m "feat(settings): add workspace unit settings model"
```

**Acceptance:** Legacy settings return empty units without a migration; valid custom units normalize predictably; cap and duplicate behavior are deterministic.

**Reviewer gate:** Check that no existing settings sections are dropped, fuzzy-rule Firestore encoding is preserved, and PUT cannot race-replace units.

---

### Task 2: Atomic authenticated workspace-unit API and client

**Files:**

- Create: `src/lib/workspace-unit-storage.ts`
- Create: `src/lib/workspace-unit-storage.test.ts`
- Create: `src/app/api/settings/units/handler.ts`
- Create: `src/app/api/settings/units/route.ts`
- Create: `src/app/api/settings/units/units-api.test.ts`
- Create: `src/lib/workspace-units-client.ts`
- Create: `src/lib/workspace-units-client.test.ts`

**Interfaces:**

- Consumes Task 1:
  - `WORKSPACE_SETTINGS_ID`
  - `fromStoredSettings`
  - `mergeWorkspaceUnit`
  - `WorkspaceUnitError`
- Produces:
  - `WorkspaceSettingsAtomicDocument`
  - `WorkspaceSettingsTransactionRunner`
  - `createWorkspaceUnitStore(runAtomic)`
  - `addWorkspaceUnitAtomically(raw)`
  - `createWorkspaceUnitsPostHandler(dependencies)`
  - authenticated `POST /api/settings/units`
  - `loadWorkspaceCustomUnits(fetchImpl, signal)`
  - `addWorkspaceUnit(unit, fetchImpl)`
- Task 5 consumes the client helpers.

- [ ] **Step 1: Write failing storage, API, and client tests**

Create `src/lib/workspace-unit-storage.test.ts` with a serialized in-memory transaction runner:

```ts
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
      if (patch) stored = { ...(stored ?? {}), ...patch }
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
```

Create `src/app/api/settings/units/units-api.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkspaceUnitError } from '@/lib/units'
import { createWorkspaceUnitsPostHandler } from './handler'

function request(body: unknown) {
  return new Request('https://example.test/api/settings/units', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('requires authentication before accepting a unit', async () => {
  let additions = 0
  const POST = createWorkspaceUnitsPostHandler({
    authenticate: async () => null,
    addUnit: async () => {
      additions += 1
      return { unit: 'bag', customUnits: ['bag'], added: true }
    },
  })

  const response = await POST(request({ unit: 'bag' }))
  assert.equal(response.status, 401)
  assert.equal(additions, 0)
})

test('returns the canonical unit and updated list for success and duplicate requests', async () => {
  const POST = createWorkspaceUnitsPostHandler({
    authenticate: async () => ({ user: {} }),
    addUnit: async () => ({
      unit: 'Bag',
      customUnits: ['Bag'],
      added: false,
    }),
  })

  const response = await POST(request({ unit: 'bag' }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    unit: 'Bag',
    customUnits: ['Bag'],
  })
})

test('maps validation and cap failures without leaking infrastructure details', async () => {
  for (const [error, status] of [
    [new WorkspaceUnitError('Unit is required.', 400), 400],
    [new WorkspaceUnitError('Workspace unit limit reached.', 409), 409],
  ] as const) {
    const POST = createWorkspaceUnitsPostHandler({
      authenticate: async () => ({ user: {} }),
      addUnit: async () => {
        throw error
      },
    })
    assert.equal((await POST(request({ unit: 'bag' }))).status, status)
  }
})
```

Create `src/lib/workspace-units-client.test.ts`:

```ts
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addWorkspaceUnit,
  loadWorkspaceCustomUnits,
} from './workspace-units-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('loads custom units while accepting legacy settings without a units section', async () => {
  const fetchImpl = (async () => jsonResponse({
    llm: { provider: 'openai', model: 'gpt-4o' },
  })) as typeof fetch

  assert.deepEqual(
    await loadWorkspaceCustomUnits(fetchImpl),
    [],
  )
})

test('throws a readable error for failed or malformed settings responses', async () => {
  const failedFetch = (async () => jsonResponse(
    { error: 'Settings unavailable.' },
    503,
  )) as typeof fetch
  await assert.rejects(
    loadWorkspaceCustomUnits(failedFetch),
    /Settings unavailable\./,
  )

  const malformedFetch = (async () => jsonResponse({
    units: { customUnits: 'bag' },
  })) as typeof fetch
  await assert.rejects(
    loadWorkspaceCustomUnits(malformedFetch),
    /Workspace units returned an invalid response\./,
  )
})

test('posts one unit and validates the canonical response', async () => {
  let receivedUrl = ''
  let receivedInit: RequestInit | undefined
  const fetchImpl = (async (input, init) => {
    receivedUrl = String(input)
    receivedInit = init
    return jsonResponse({ unit: 'Bag', customUnits: ['Bag'] })
  }) as typeof fetch

  assert.deepEqual(await addWorkspaceUnit('bag', fetchImpl), {
    unit: 'Bag',
    customUnits: ['Bag'],
  })
  assert.equal(receivedUrl, '/api/settings/units')
  assert.equal(receivedInit?.method, 'POST')
  assert.equal(
    receivedInit?.body,
    JSON.stringify({ unit: 'bag' }),
  )
})

test('preserves the server error message for an add failure', async () => {
  const fetchImpl = (async () => jsonResponse(
    { error: 'Workspace unit limit reached.' },
    409,
  )) as typeof fetch

  await assert.rejects(
    addWorkspaceUnit('bag', fetchImpl),
    /Workspace unit limit reached\./,
  )
})
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
npx tsx --test src/lib/workspace-unit-storage.test.ts src/app/api/settings/units/units-api.test.ts src/lib/workspace-units-client.test.ts
```

Expected: FAIL because the files do not exist.

- [ ] **Step 3: Implement the atomic store**

Use a narrow adapter so concurrency can be tested without importing Firestore into the pure tests:

```ts
export interface WorkspaceSettingsAtomicDocument {
  read(): Promise<unknown | null>
  write(patch: Record<string, unknown>): void
}

export type WorkspaceSettingsTransactionRunner = <T>(
  work: (document: WorkspaceSettingsAtomicDocument) => Promise<T>,
) => Promise<T>

export function createWorkspaceUnitStore(
  runAtomic: WorkspaceSettingsTransactionRunner,
) {
  return {
    async add(raw: unknown) {
      return runAtomic(async (document) => {
        const current = fromStoredSettings(
          await document.read() as StoredWorkspaceSettings | null,
        )
        const result = mergeWorkspaceUnit(current.units.customUnits, raw)
        document.write({
          units: { customUnits: result.customUnits },
        })
        return result
      })
    },
  }
}
```

Create the production runner with `runTransaction`:

```ts
const productionRunner: WorkspaceSettingsTransactionRunner = (work) =>
  runTransaction(async (transaction, db) => {
    const reference = db
      .collection('settings')
      .doc(WORKSPACE_SETTINGS_ID)

    return work({
      read: async () => {
        const snapshot = await transaction.get(reference)
        return snapshot.exists ? snapshot.data() : null
      },
      write: (patch) => {
        transaction.set(reference, patch, { merge: true })
      },
    })
  })

export const addWorkspaceUnitAtomically =
  createWorkspaceUnitStore(productionRunner).add
```

The read and write must remain inside the same Firestore transaction callback.

- [ ] **Step 4: Implement the handler factory and Route Handler adapter**

`src/app/api/settings/units/handler.ts`:

```ts
interface WorkspaceUnitsHandlerDependencies {
  authenticate: () => Promise<{ user?: unknown } | null>
  addUnit: (
    unit: unknown,
  ) => Promise<WorkspaceUnitMergeResult>
}

export function createWorkspaceUnitsPostHandler({
  authenticate,
  addUnit,
}: WorkspaceUnitsHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const session = await authenticate()
    if (!session?.user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    }

    try {
      const body: unknown = await request.json()
      if (
        typeof body !== 'object'
        || body === null
        || Array.isArray(body)
        || Object.keys(body).length !== 1
        || !('unit' in body)
      ) {
        return Response.json(
          { error: 'Request must contain only unit.' },
          { status: 400 },
        )
      }

      const result = await addUnit((body as { unit: unknown }).unit)
      return Response.json({
        unit: result.unit,
        customUnits: result.customUnits,
      })
    } catch (error) {
      if (error instanceof SyntaxError) {
        return Response.json(
          { error: 'Request body must be valid JSON.' },
          { status: 400 },
        )
      }
      if (error instanceof WorkspaceUnitError) {
        return Response.json(
          { error: error.message },
          { status: error.status },
        )
      }
      console.error('Error adding workspace unit:', error)
      return Response.json(
        { error: 'Internal server error' },
        { status: 500 },
      )
    }
  }
}
```

`src/app/api/settings/units/route.ts`:

```ts
import { auth } from '@/lib/auth'
import { addWorkspaceUnitAtomically } from '@/lib/workspace-unit-storage'
import { createWorkspaceUnitsPostHandler } from './handler'

export const POST = createWorkspaceUnitsPostHandler({
  authenticate: auth,
  addUnit: addWorkspaceUnitAtomically,
})
```

Do not add caching or a GET method here; `/api/settings` remains the read endpoint.

- [ ] **Step 5: Implement typed client helpers**

`src/lib/workspace-units-client.ts` exports:

```ts
export async function loadWorkspaceCustomUnits(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string[]>

export async function addWorkspaceUnit(
  unit: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ unit: string; customUnits: string[] }>
```

Required behavior:

- `loadWorkspaceCustomUnits` fetches `/api/settings`.
- Missing `units` means `[]` for legacy compatibility.
- Malformed `units.customUnits` throws `"Workspace units returned an invalid response."`.
- `addWorkspaceUnit` posts JSON to `/api/settings/units`.
- Non-OK responses use the server’s `error` string through a local `responseError` helper.
- Success validates `unit` as a string and sanitizes `customUnits`; malformed success throws.

- [ ] **Step 6: Run focused validation**

```bash
npx tsx --test src/lib/workspace-unit-storage.test.ts src/app/api/settings/units/units-api.test.ts src/lib/workspace-units-client.test.ts
npx tsc --noEmit
```

Expected: all focused tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/workspace-unit-storage.ts src/lib/workspace-unit-storage.test.ts src/app/api/settings/units/handler.ts src/app/api/settings/units/route.ts src/app/api/settings/units/units-api.test.ts src/lib/workspace-units-client.ts src/lib/workspace-units-client.test.ts
git commit -m "feat(settings): persist workspace units atomically"
```

**Acceptance:** POST is authenticated, validates one unit, is idempotent, uses a Firestore transaction, returns 400/401/409 correctly, and cannot lose concurrent additions.

**Reviewer gate:** Verify the production adapter uses one transaction and never performs a separate pre-transaction read or a whole-settings replacement.

---

### Task 3: Portaled searchable Unit combobox

**Files:**

- Modify: `src/components/unit-combobox.tsx`
- Modify: `src/components/unit-combobox.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**

- Consumes Task 1 unit helpers.
- Produces:

```ts
export interface UnitComboboxProps {
  value: string
  units: string[]
  onChange: (unit: string) => void
  onAddUnit: (unit: string) => Promise<string> | string | void
  workspaceLoadError?: string | null
  disabled?: boolean
  readOnly?: boolean
  ariaLabel?: string
}
```

- Task 5 supplies the persistence callback and load error.

- [ ] **Step 1: Add failing component/source contracts**

Update `src/components/unit-combobox.test.ts`:

```ts
const source = readFileSync(
  new URL('./unit-combobox.tsx', import.meta.url),
  'utf8',
)

const baseProps = {
  units: ['m³', 'm²', 'ton'],
  onChange: () => undefined,
  onAddUnit: async (unit: string) => unit,
}

test('uses the Base UI portaled combobox with collision positioning', () => {
  assert.match(source, /@base-ui\/react\/combobox/)
  assert.match(source, /ComboboxPrimitive\.Portal/)
  assert.match(source, /ComboboxPrimitive\.Positioner/)
  assert.match(source, /collisionPadding=\{8\}/)
  assert.match(source, /sideOffset=\{4\}/)
  assert.doesNotMatch(source, /position:\s*absolute/)
})

test('shows named workspace add actions and preserves errors', () => {
  assert.match(source, />Add workspace unit</)
  assert.match(source, />Workspace unit</)
  assert.match(source, /Available in all BOQs in this workspace\./)
  assert.match(source, />Cancel</)
  assert.match(source, />Add unit</)
  assert.match(source, /maxLength=\{MAX_UNIT_LENGTH\}/)
  assert.match(source, /role="alert"/)
})

test('delegates option keyboard behavior to Base UI listbox primitives', () => {
  assert.match(source, /ComboboxPrimitive\.Input/)
  assert.match(source, /ComboboxPrimitive\.List/)
  assert.match(source, /ComboboxPrimitive\.Item/)
  assert.match(source, /\bautoHighlight(?:=\{true\})?/)
})
```

Retain the current trigger, placeholder, disabled, and read-only SSR tests.

- [ ] **Step 2: Verify the new contracts fail**

```bash
npx tsx --test src/components/unit-combobox.test.ts
```

Expected: FAIL because the component still renders an absolute in-cell menu.

- [ ] **Step 3: Replace the hand-rolled popup with Base UI Combobox**

Use:

```ts
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
```

Controlled state:

```ts
const [open, setOpen] = useState(false)
const [query, setQuery] = useState('')
const [adding, setAdding] = useState(false)
const [draft, setDraft] = useState('')
const [addingUnit, setAddingUnit] = useState(false)
const [addError, setAddError] = useState<string | null>(null)
const triggerRef = useRef<HTMLButtonElement>(null)
const searchRef = useRef<HTMLInputElement>(null)
const addInputRef = useRef<HTMLInputElement>(null)
const addInputId = useId()
const filteredUnits = filterUnits(units, query)
```

Core composition:

```tsx
<ComboboxPrimitive.Root<string>
  items={units}
  filteredItems={filteredUnits}
  filter={null}
  value={value || null}
  open={open}
  inputValue={query}
  autoHighlight
  modal={false}
  onInputValueChange={setQuery}
  onOpenChange={(nextOpen) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery('')
      setAdding(false)
      setDraft('')
      setAddError(null)
    }
  }}
  onValueChange={(unit) => {
    if (!unit) return
    onChange(unit)
    setOpen(false)
  }}
>
  <ComboboxPrimitive.Trigger
    ref={triggerRef}
    render={
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="unit-combobox-trigger"
        disabled={disabled}
        aria-label={ariaLabel}
      />
    }
  >
    <span className="unit-combobox-value">{value || 'Unit…'}</span>
    <ChevronDown aria-hidden="true" />
  </ComboboxPrimitive.Trigger>

  <ComboboxPrimitive.Portal>
    <ComboboxPrimitive.Positioner
      align="start"
      sideOffset={4}
      collisionPadding={8}
      className="unit-combobox-positioner"
    >
      <ComboboxPrimitive.Popup
        className="unit-combobox-popover"
        initialFocus={adding ? addInputRef : searchRef}
        finalFocus={triggerRef}
      >
        {adding ? (
          <form
            className="unit-combobox-add-form"
            onSubmit={(event) => {
              event.preventDefault()
              void commitAdd()
            }}
          >
            <label htmlFor={addInputId}>Workspace unit</label>
            <Input
              id={addInputId}
              ref={addInputRef}
              value={draft}
              maxLength={MAX_UNIT_LENGTH}
              disabled={addingUnit}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.preventDefault()
                event.stopPropagation()
                setAdding(false)
                setDraft('')
                setAddError(null)
              }}
            />
            <p>Available in all BOQs in this workspace.</p>
            {addError ? <p role="alert">{addError}</p> : null}
            <div className="unit-combobox-add-actions">
              <Button
                type="button"
                variant="outline"
                disabled={addingUnit}
                onClick={() => {
                  setAdding(false)
                  setDraft('')
                  setAddError(null)
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={addingUnit}>
                Add unit
              </Button>
            </div>
          </form>
        ) : (
          <>
            <div className="unit-combobox-search">
              <Search aria-hidden="true" />
              <ComboboxPrimitive.Input
                ref={searchRef}
                className="unit-combobox-search-input"
                placeholder="Search units…"
                aria-label={`Search ${ariaLabel}`}
              />
            </div>
            {workspaceLoadError ? (
              <p className="unit-combobox-load-error" role="status">
                {workspaceLoadError}
              </p>
            ) : null}
            <ComboboxPrimitive.List className="unit-combobox-list">
              <ComboboxPrimitive.Empty className="unit-combobox-empty">
                No units match
              </ComboboxPrimitive.Empty>
              {filteredUnits.map((unit) => (
                <ComboboxPrimitive.Item
                  key={unit}
                  value={unit}
                  className="unit-combobox-option"
                >
                  <span>{unit}</span>
                  <ComboboxPrimitive.ItemIndicator>
                    <Check aria-hidden="true" />
                  </ComboboxPrimitive.ItemIndicator>
                </ComboboxPrimitive.Item>
              ))}
            </ComboboxPrimitive.List>
            <button
              type="button"
              className="unit-combobox-add-toggle"
              onClick={() => setAdding(true)}
            >
              <Plus aria-hidden="true" />
              Add workspace unit
            </button>
          </>
        )}
      </ComboboxPrimitive.Popup>
    </ComboboxPrimitive.Positioner>
  </ComboboxPrimitive.Portal>
</ComboboxPrimitive.Root>
```

The browse state contains `ComboboxPrimitive.Input`, `List`, `Item`, `ItemIndicator`, Empty copy, load-error copy, and **Add workspace unit**.

The add form must:

1. Normalize with `normalizeWorkspaceUnit`.
2. Select an existing canonical value without POST.
3. Await `onAddUnit` for a new value. During Task 3 the existing session-only callback may return `void`; use `(await onAddUnit(unit)) ?? unit` as the canonical value. Task 5 replaces the caller with the persistence callback returning `Promise<string>`.
4. Call `onChange(canonical)` only after the callback succeeds.
5. Preserve `draft` and show `addError` on rejection.
6. Keep `addingUnit` true only during the request.
7. Make Escape cancel the add state without closing the whole combobox by preventing and stopping that key event.
8. Use `maxLength={MAX_UNIT_LENGTH}`.
9. When `adding` becomes true while the popup is already open, focus `addInputRef.current` in an effect; `initialFocus` alone is insufficient because the popup does not remount.

- [ ] **Step 4: Close on relevant layout changes**

While open, listen only to:

- `resize` on `window`.
- `scroll` on the trigger’s nearest `.unified-boq-table-scroll`.

Do not bind a captured document-wide scroll listener because scrolling the option list must not close its own popup.

Base UI handles outside press, Escape in browse mode, focus return, Arrow keys, Home/End, Enter, and ARIA relationships.

- [ ] **Step 5: Replace combobox CSS**

Required values:

```css
.unit-combobox-trigger {
  width: 100%;
  height: 30px;
  justify-content: space-between;
  padding-inline: 7px;
  border-radius: 7px;
  font-size: 12px;
}

.unit-combobox-positioner {
  z-index: 60;
  width: 244px;
  max-width: calc(100vw - 16px);
}

.unit-combobox-popover {
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
  box-shadow: var(--elev-raised), 0 14px 36px rgba(4, 14, 32, 0.16);
}

.unit-combobox-search input {
  height: 34px;
}

.unit-combobox-list {
  max-height: 192px;
  overflow-y: auto;
}

.unit-combobox-option {
  min-height: 32px;
}

.unit-combobox-option[data-highlighted] {
  background: color-mix(in oklab, var(--accent) 9%, transparent);
}
```

Add compact add-form layout, inline error/load-error styling, `data-open` transition styling, and include the combobox classes in the reduced-motion rule.

- [ ] **Step 6: Run focused tests**

```bash
npx tsx --test src/lib/units.test.ts src/components/unit-combobox.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/unit-combobox.tsx src/components/unit-combobox.test.ts src/app/globals.css
git commit -m "feat(boq): portal the workspace unit combobox"
```

**Acceptance:** Popup is outside table overflow, collision-aware, keyboard operable, restores focus, and never reports a failed unit addition as successful.

**Reviewer gate:** Inspect Base UI composition and keyboard/focus behavior; reject custom ARIA reimplementation or premature `onChange`.

---

### Task 4: Stable item identity and draft-state primitives

**Files:**

- Modify: `src/lib/boq-item-identity.ts`
- Modify: `src/lib/boq-item-identity.test.ts`
- Modify: `src/lib/boq-detail-state.ts`
- Modify: `src/lib/boq-detail-state.test.ts`
- Modify: `src/lib/boq-unified-rows.ts`
- Modify: `src/lib/boq-unified-rows.test.ts`

**Interfaces:**

- Produces:

```ts
export interface BoqItemLocation {
  identityKey: string
  sectionIndex: number
  itemIndex: number
  item: BoqItem
}

export type BoqItemLocationResolution =
  | { status: 'found'; location: BoqItemLocation }
  | { status: 'not-found' | 'ambiguous' }

export function resolveBoqItemIdentityKey(
  sections: BoqSection[],
  identityKey: string,
): BoqItemLocationResolution

export type BoqUpdatedAtComparison =
  | 'incoming-newer'
  | 'incoming-older'
  | 'equal'
  | 'invalid'

export function compareBoqUpdatedAt(
  current: Pick<Boq, 'updatedAt'>,
  incoming: Pick<Boq, 'updatedAt'>,
): BoqUpdatedAtComparison

export interface ResolvedBoqDetailEdit extends BoqItemLocation {
  edit: Record<string, string | number | undefined>
}

export interface BoqDraftResolutionIssue {
  identityKey: string
  status: 'not-found' | 'ambiguous'
}

export function resolveBoqDetailEdits(
  boq: Boq,
  edits: BoqDetailEdits,
): {
  resolved: ResolvedBoqDetailEdit[]
  issues: BoqDraftResolutionIssue[]
}

export function applyBoqDetailEdits(
  boq: Boq,
  edits: BoqDetailEdits,
): {
  boq: Boq
  issues: BoqDraftResolutionIssue[]
}

export function takeBoqDetailDraft(
  edits: BoqDetailEdits,
  identityKey: string,
): {
  edits: BoqDetailEdits
  draft?: BoqDetailEdits[string]
}

export function restoreBoqDetailDraft(
  edits: BoqDetailEdits,
  identityKey: string,
  draft: BoqDetailEdits[string] | undefined,
): BoqDetailEdits
```

- `reconcileBoqMutation` returns `issues` in addition to `boq` and `edits`.
- Unified rows expose `identityKey?: string` and `identityIssue?: 'missing' | 'ambiguous'`.
- Tasks 5 and 6 consume all of these.

- [ ] **Step 1: Write failing identity-location tests**

Add to `src/lib/boq-item-identity.test.ts`:

```ts
test('resolves an item after earlier sections and rows are removed', () => {
  const sections = [
    { header: 'Remaining', items: [item({ id: 'target' })] },
  ]

  assert.deepEqual(
    resolveBoqItemIdentityKey(sections, 'id:target'),
    {
      status: 'found',
      location: {
        identityKey: 'id:target',
        sectionIndex: 0,
        itemIndex: 0,
        item: sections[0]!.items[0]!,
      },
    },
  )
})

test('rejects missing and globally duplicated identities', () => {
  const duplicate = item({ id: undefined, code: 'DUP' })
  const sections = [
    { header: 'A', items: [duplicate] },
    { header: 'B', items: [{ ...duplicate }] },
  ]

  assert.deepEqual(
    resolveBoqItemIdentityKey(sections, 'code:DUP'),
    { status: 'ambiguous' },
  )
  assert.deepEqual(
    resolveBoqItemIdentityKey(sections, 'id:missing'),
    { status: 'not-found' },
  )
})
```

- [ ] **Step 2: Write failing stable-draft tests**

Replace positional keys in `src/lib/boq-detail-state.test.ts` with `id:*` or `code:*`, then add:

```ts
test('drafts stay attached to identity after insertion and section pruning', () => {
  const edits = {
    'id:target': { desc: 'Local target', qty: 7 },
  }
  const incoming = boq([
    [item({ id: 'inserted', code: 'INSERTED' })],
    [item({ id: 'target', code: 'TARGET' })],
  ])

  const result = applyBoqDetailEdits(incoming, edits)
  assert.deepEqual(result.issues, [])
  assert.equal(result.boq.sections[1]!.items[0]!.desc, 'Local target')
  assert.equal(result.boq.sections[1]!.items[0]!.qty, 7)
  assert.equal(result.boq.sections[0]!.items[0]!.desc, 'Source item')
})

test('ambiguous identities are not applied to either row', () => {
  const source = boq([
    [item({ id: undefined, code: 'DUP', desc: 'First' })],
    [item({ id: undefined, code: 'DUP', desc: 'Second' })],
  ])

  const result = applyBoqDetailEdits(source, {
    'code:DUP': { desc: 'Unsafe edit' },
  })

  assert.deepEqual(result.issues, [{
    identityKey: 'code:DUP',
    status: 'ambiguous',
  }])
  assert.equal(result.boq.sections[0]!.items[0]!.desc, 'First')
  assert.equal(result.boq.sections[1]!.items[0]!.desc, 'Second')
})

test('delete staging removes and restores only the selected draft', () => {
  const original = {
    'id:first': { qty: 2 },
    'id:second': { desc: 'Keep me' },
  }
  const taken = takeBoqDetailDraft(original, 'id:first')

  assert.deepEqual(taken.edits, {
    'id:second': { desc: 'Keep me' },
  })
  assert.deepEqual(
    restoreBoqDetailDraft(taken.edits, 'id:first', taken.draft),
    original,
  )
})

test('orders canonical responses by updatedAt and rejects invalid revisions', () => {
  assert.equal(
    compareBoqUpdatedAt(
      { updatedAt: '2026-07-30T10:00:00.000Z' },
      { updatedAt: '2026-07-30T10:00:01.000Z' },
    ),
    'incoming-newer',
  )
  assert.equal(
    compareBoqUpdatedAt(
      { updatedAt: '2026-07-30T10:00:01.000Z' },
      { updatedAt: '2026-07-30T10:00:00.000Z' },
    ),
    'incoming-older',
  )
  assert.equal(
    compareBoqUpdatedAt(
      { updatedAt: '2026-07-30T10:00:00.000Z' },
      { updatedAt: '2026-07-30T10:00:00.000Z' },
    ),
    'equal',
  )
  assert.equal(
    compareBoqUpdatedAt(
      { updatedAt: 'invalid' },
      { updatedAt: '2026-07-30T10:00:00.000Z' },
    ),
    'invalid',
  )
})
```

Retain tests proving catalog standardization clears only `desc` and `unit`, but update their keys to stable identities and add row insertion before the matched row.

- [ ] **Step 3: Verify tests fail**

```bash
npx tsx --test src/lib/boq-item-identity.test.ts src/lib/boq-detail-state.test.ts src/lib/boq-unified-rows.test.ts
```

Expected: FAIL because global identity resolution and stable draft helpers do not exist.

- [ ] **Step 4: Implement global identity resolution**

In `src/lib/boq-item-identity.ts`, compare `getBoqItemIdentityKey(item)` across every section. Return `ambiguous` whenever more than one location matches, including duplicate IDs in separate sections.

Do not parse the key into section data and do not accept a positional fallback.

- [ ] **Step 5: Refactor BOQ detail draft helpers**

Move `mergeItemEdits` from the page into `src/lib/boq-detail-state.ts` as an internal or exported `mergeBoqItemEdits`.

Implement `resolveBoqDetailEdits` once and reuse it for display overlay and save preparation. `applyBoqDetailEdits` must clone only resolved items and must not apply an ambiguous edit twice.

Rewrite `reconcileBoqMutation` to iterate stable edit keys:

```ts
for (const identityKey of Object.keys(edits)) {
  const previousResolution = resolveBoqItemIdentityKey(
    previous.sections,
    identityKey,
  )
  const incomingResolution = resolveBoqItemIdentityKey(
    incoming.sections,
    identityKey,
  )

  if (
    previousResolution.status !== 'found'
    || incomingResolution.status !== 'found'
  ) {
    issues.push({
      identityKey,
      status: previousResolution.status === 'ambiguous'
        || incomingResolution.status === 'ambiguous'
        ? 'ambiguous'
        : 'not-found',
    })
    continue
  }

  if (
    matchedStandardizationChanged(
      previousResolution.location.item,
      incomingResolution.location.item,
    )
  ) {
    // Clone once; delete only desc/unit; preserve qty and component drafts.
  }
}
```

Keep `sourceAvailable` preservation unchanged.

Implement `compareBoqUpdatedAt` with `Date.parse`. Return `invalid` if either timestamp is not finite, otherwise compare milliseconds exactly. Task 5 uses this as the single stale-response gate.

- [ ] **Step 6: Annotate unified rows with identity validity**

`buildUnifiedBoqSections` first counts each stable key globally. Each row gets:

```ts
identityKey,
identityIssue: !identityKey
  ? 'missing'
  : identityCounts.get(identityKey) === 1
    ? undefined
    : 'ambiguous',
```

The existing section-namespaced React/catalog `row.key` may remain for rendering and catalog transient state. It must never become the draft key.

Add tests for unique, missing, and globally duplicated identities.

- [ ] **Step 7: Run focused tests**

```bash
npx tsx --test src/lib/boq-item-identity.test.ts src/lib/boq-detail-state.test.ts src/lib/boq-unified-rows.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/boq-item-identity.ts src/lib/boq-item-identity.test.ts src/lib/boq-detail-state.ts src/lib/boq-detail-state.test.ts src/lib/boq-unified-rows.ts src/lib/boq-unified-rows.test.ts
git commit -m "refactor(boq): key detail drafts by stable identity"
```

**Acceptance:** Insertions, deletions, and section pruning cannot transfer a draft to another item. Missing/duplicate identities are explicit and never fall back to positions.

**Reviewer gate:** Search the changed state files for positional draft keys and test duplicate identities across sections.

---

### Task 5: Wire stable drafts, workspace units, and action-specific busy state

**Files:**

- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Modify: `src/app/(authenticated)/boqs/[id]/page.test.ts`
- Modify: `src/components/unified-boq-items-table.tsx`
- Modify: `src/components/unified-boq-items-table.test.ts`

**Interfaces:**

- Consumes Tasks 2–4.
- Changes table props to:

```ts
export interface UnifiedBoqItemsTableProps {
  sections: UnifiedBoqSection[]
  readOnly: boolean
  editingDisabled: boolean
  catalogDisabled?: boolean
  catalogState: (
    row: UnifiedBoqPricedRow,
  ) => InlineCatalogRowState
  onFieldChange: (
    row: UnifiedBoqPricedRow,
    field: EditableBoqField,
    value: string | number | undefined,
  ) => void
  onAcceptSuggestion: (row: UnifiedBoqPricedRow) => void
  onAiSuggest: (row: UnifiedBoqPricedRow) => void
  onDismissSuggestion: (row: UnifiedBoqPricedRow) => void
  onFindMatch: (row: UnifiedBoqPricedRow) => void
  onExclude: (row: UnifiedBoqPricedRow) => void
  onClearCatalogError?: (key: string) => void
  onComponentDraftValidityChange?: (
    key: string,
    isInvalid: boolean,
  ) => void
  onDelete?: (row: UnifiedBoqPricedRow) => void
  onIncludeOptional?: (row: UnifiedBoqPricedRow) => void
  isIncludeBusy?: (row: UnifiedBoqPricedRow) => boolean
  units: string[]
  workspaceUnitsError?: string | null
  onAddUnit: (unit: string) => Promise<string>
}
```

- Task 6 retains these interfaces.

- [ ] **Step 1: Replace obsolete page tests with failing stable-flow contracts**

Update `src/app/(authenticated)/boqs/[id]/page.test.ts`:

```ts
test('uses stable item identities for display and save resolution', () => {
  assert.doesNotMatch(source, /function rowEditKey/)
  assert.doesNotMatch(source, /\$\{row\.sectionIndex\}-\$\{row\.itemIndex\}/)
  assert.match(source, /getBoqItemIdentityKey/)
  assert.match(source, /applyBoqDetailEdits/)
  assert.match(source, /resolveBoqDetailEdits/)
})

test('does not use one broad mutation busy flag', () => {
  assert.doesNotMatch(source, /\bmutationBusy\b/)
  assert.match(source, /editingDisabled=\{saving \|\| approving\}/)
  assert.match(source, /disabled:\s*isReadOnly/)
  assert.match(source, /disabled=\{addingItem/)
})

test('loads and persists workspace units through settings APIs', () => {
  assert.match(source, /loadWorkspaceCustomUnits/)
  assert.match(source, /addWorkspaceUnit/)
  assert.match(source, /combineUnitOptions/)
  assert.match(source, /workspaceUnitsError=/)
  assert.match(source, /added to workspace units/)
})

test('coordinates overlapping mutations before force-applying a refresh', () => {
  assert.match(source, /compareBoqUpdatedAt/)
  assert.match(source, /activeCanonicalMutationsRef/)
  assert.match(source, /mutationEpochRef/)
  assert.match(source, /mutationOverlapRef/)
  assert.match(source, /canonicalRefreshNeededRef/)
  assert.match(source, /canonicalRefreshRef/)
  assert.match(source, /refreshWasOvertaken/)
})
```

Remove the two tests asserting `"Save pending changes before deleting an item"`.

Update table tests:

- Rename the catalog-busy test to assert that only catalog controls are disabled.
- Assert Description, Unit, Qty, Material, and Labour remain editable when `rowCatalogState.busy` is non-null.
- Assert a missing/ambiguous identity disables persistent controls and renders a visible warning.
- Retain exact full-table header order.

- [ ] **Step 2: Verify tests fail**

```bash
npx tsx --test 'src/app/(authenticated)/boqs/[id]/page.test.ts' src/components/unified-boq-items-table.test.ts
```

Expected: FAIL because positional keys and `mutationBusy` remain.

- [ ] **Step 3: Replace page display/save draft resolution**

Import:

```ts
import {
  applyBoqDetailEdits,
  compareBoqUpdatedAt,
  reconcileBoqMutation,
  resolveBoqDetailEdits,
  type BoqDetailEdits,
} from '@/lib/boq-detail-state'
import { getBoqItemIdentityKey } from '@/lib/boq-item-identity'
```

Remove `rowEditKey` and the page-local `mergeItemEdits`.

Keep a latest canonical ref:

```ts
const boqRef = useRef(boq)

useEffect(() => {
  boqRef.current = boq
}, [boq])
```

`applyMutationBoq(incoming, { force = false } = {})` is the only direct canonical-response application boundary. `force` skips timestamp filtering but still performs stable draft reconciliation; it is allowed only for an idle authoritative GET or the approval response protected by the synchronous no-concurrency barrier. Otherwise it compares `incoming.updatedAt` with `boqRef.current.updatedAt` before reconciliation:

- `incoming-newer`: reconcile, update `boqRef.current` synchronously, then publish state.
- `equal` with identical canonical payload: no-op.
- `incoming-older`, `equal` with differing payload, or `invalid`: do not apply by arrival order; set `canonicalRefreshNeededRef.current = true`.

Timestamps are only a fast response filter, not a commit-order token. Route every canonical mutation through this coordinator:

```ts
async function runCanonicalMutation<T>(
  work: () => Promise<T>,
): Promise<T> {
  if (activeCanonicalMutationsRef.current > 0) {
    mutationOverlapRef.current = true
  }
  activeCanonicalMutationsRef.current += 1
  mutationEpochRef.current += 1
  setActiveCanonicalMutations((count) => count + 1)

  try {
    return await work()
  } finally {
    activeCanonicalMutationsRef.current -= 1
    setActiveCanonicalMutations((count) => count - 1)
    if (
      activeCanonicalMutationsRef.current === 0
      && (mutationOverlapRef.current
        || canonicalRefreshNeededRef.current)
    ) {
      void refreshCanonicalAfterIdle()
    }
  }
}
```

`refreshCanonicalAfterIdle` deduplicates through `canonicalRefreshRef`, captures `const epoch = mutationEpochRef.current`, and GETs `/api/boqs/${encodeURIComponent(boqRef.current.id)}` only when the active count is zero. The created refresh task owns a local `let refreshWasOvertaken = false`:

1. If the active count is nonzero or the epoch changed when GET returns, set `refreshWasOvertaken = true`, discard the fetched snapshot, and keep `canonicalRefreshNeededRef.current = true`.
2. Otherwise force the GET response through stable draft reconciliation regardless of its `updatedAt`; it was fetched after every known mutation in that epoch settled. Update `boqRef.current` before publishing, then clear `mutationOverlapRef` and `canonicalRefreshNeededRef`.
3. In `finally`, clear `canonicalRefreshRef` only if it still points to this task. After clearing it, if `refreshWasOvertaken`, the active count is zero, and refresh is still needed, immediately call `refreshCanonicalAfterIdle()` again. This closes the gap where the replacing mutation finished before the old promise cleared.
4. On network/parse failure, keep the current BOQ/drafts and refresh-needed flag and show one error toast. Before leaving `catch`, set `refreshWasOvertaken = true` when the epoch changed or the active count became nonzero while the failed request was in flight; its `finally` then performs the one required replacement refresh. For an ordinary failure with no overtaking mutation, leave `refreshWasOvertaken = false` and do not immediately loop; the next canonical mutation or explicit retry may schedule another refresh.

If `refreshCanonicalAfterIdle` is called while a task already exists, return that task; the existing task’s `finally` owns overtaken rescheduling. This catches both cases a timestamp comparison cannot: an earlier timestamp that commits later after transaction retry, and a stale later-arriving response from overlapping requests. A refresh overtaken by a new mutation can never be force-applied or strand the refresh-needed flag. Add the pure timestamp comparison test in Task 4 and the page source coordinator contract above.

For display:

```ts
const displayedItems = useMemo(
  () => applyBoqDetailEdits(boq, edits),
  [boq, edits],
)

const displayBoq = useMemo<Boq>(() => ({
  ...displayedItems.boq,
  ...metadataEdits,
}), [displayedItems.boq, metadataEdits])
```

`handleEdit`:

```ts
const identityKey = getBoqItemIdentityKey(row.item)
if (!identityKey || row.identityIssue) {
  toast.error('This item has no unique identity and cannot be edited.')
  return
}

const current = editsRef.current
replaceEdits({
  ...current,
  [identityKey]: {
    ...current[identityKey],
    [field]: value,
  },
})
```

In `handleSaveAll`, resolve the snapshot against `boqRef.current`. If any issue exists, abort before network calls and preserve all drafts. Build PATCH groups from `resolved` locations:

```ts
const resolution = resolveBoqDetailEdits(
  boqRef.current,
  editSnapshot,
)
if (resolution.issues.length > 0) {
  toast.error('Some unsaved items no longer have a unique BOQ identity.')
  return
}

for (const resolved of resolution.resolved) {
  const group = updates.get(resolved.sectionIndex) ?? {
    sectionIndex: resolved.sectionIndex,
    items: [],
  }
  group.items.push({
    ...getBoqItemRequestIdentity(resolved.item),
    ...resolved.edit,
  })
  updates.set(resolved.sectionIndex, group)
}
```

Keep both `editSnapshot` and `metadataSnapshot` in the local refs/state until every request in **Save draft** succeeds. Metadata and item requests may still persist sequentially on the server, but do not call `replaceEdits({})` or `replaceMetadataEdits({})` at either intermediate response. Apply successful canonical responses through `applyMutationBoq`, then clear both snapshots together at the common success boundary. If any later request fails, preserve both local snapshots so retry is safe and idempotent. Preserve the linked-catalog confirmation.

- [ ] **Step 4: Load and add workspace units**

Add:

```ts
const [customUnits, setCustomUnits] = useState<string[]>([])
const [workspaceUnitsError, setWorkspaceUnitsError] =
  useState<string | null>(null)

const units = useMemo(
  () => combineUnitOptions(customUnits),
  [customUnits],
)
```

Load on BOQ workspace mount with an `AbortController`. Failure leaves standard units available and stores a nonblocking error.

Add:

```ts
const handleAddWorkspaceUnit = useCallback(
  async (raw: string): Promise<string> => {
    const result = await addWorkspaceUnit(raw)
    setCustomUnits(result.customUnits)
    setWorkspaceUnitsError(null)
    toast.success(`“${result.unit}” added to workspace units`)
    return result.unit
  },
  [],
)
```

Pass `handleAddWorkspaceUnit` to the table. The combobox calls `onFieldChange` only after this promise resolves, so the row selection enters the local edit map and is not persisted until **Save draft**.

- [ ] **Step 5: Replace broad busy state with action-specific state**

Remove `mutationBusy`.

Use separate state:

```ts
const [saving, setSaving] = useState(false)
const [approving, setApproving] = useState(false)
const [addingItem, setAddingItem] = useState(false)
const [catalogModalBusy, setCatalogModalBusy] = useState(false)
const [excludeBusy, setExcludeBusy] = useState(false)
const [includingItemKeys, setIncludingItemKeys] =
  useState<Set<string>>(new Set())
const [deletingBoq, setDeletingBoq] = useState(false)
const [activeCanonicalMutations, setActiveCanonicalMutations] = useState(0)
const activeCanonicalMutationsRef = useRef(0)
const mutationEpochRef = useRef(0)
const mutationOverlapRef = useRef(false)
const canonicalRefreshNeededRef = useRef(false)
const canonicalRefreshRef = useRef<Promise<void> | null>(null)
const approvalBarrierRef = useRef(false)
```

Required guards:

- Draft/metadata editing: `isReadOnly || saving || approving`; handlers also check `approvalBarrierRef.current` so the barrier is synchronous before React rerenders.
- Save: `isReadOnly || saving || approving`.
- Add missing item: `isReadOnly || addingItem || approving`.
- Include optional: only the target identity key is busy normally; all include actions also stop while `approving`.
- Inline catalog hook: `disabled: isReadOnly || approving`.
- Route every async mutation that returns or changes canonical BOQ data through `runCanonicalMutation`: Save, inline Accept/AI suggest, manual match, Exclude, Include, Add missing item, delete commit, delete BOQ, and approval. The helper increments `activeCanonicalMutationsRef.current` and `mutationEpochRef.current` synchronously, mirrors the active count in state, marks `mutationOverlapRef.current` if another canonical mutation was already active, and decrements in `finally`. Approval checks the ref before starting so a same-frame click cannot slip through.
- Inline catalog actions rely on their existing per-row controller busy state.
- Manual-match reload uses `catalogModalBusy` only for the modal flow and stops while `approving`.
- Exclude dialog uses `excludeBusy` only and stops while `approving`.
- Item delete remains independent of unsaved drafts but stops while `approving`.
- Delete BOQ uses `deletingBoq` and its existing confirmation and stops while `approving`.
- Extraction corrections may keep their existing unsaved-draft blocker because they are outside the approved non-blocking row/catalog list.
- Toggling between items/extraction must not be blocked merely by unsaved drafts.

- [ ] **Step 6: Refactor table locks**

For each priced row:

```ts
const identityLocked = row.identityIssue !== undefined
const editingLocked =
  readOnly || editingDisabled || identityLocked
const catalogLocked =
  readOnly || catalogDisabled || identityLocked
```

Do not include `rowCatalogState.busy` in `editingLocked`.

Pass `catalogLocked` to `InlineCatalogCell`; it already adds its own row-busy lock.

For missing/ambiguous identities:

- Render a `.review-item-warning`.
- Disable edit, catalog, include, and delete controls for that row.
- Use:
  - `"This row has no persistent item identity."`
  - `"This row's item identity is duplicated."`

Pass `workspaceUnitsError` to every `UnitCombobox`. Retain and forward `onClearCatalogError` to `InlineCatalogCell` and `onComponentDraftValidityChange` to both component-cost editors exactly as the current table does.

- [ ] **Step 7: Run focused tests**

```bash
npx tsx --test src/lib/workspace-units-client.test.ts src/lib/boq-detail-state.test.ts src/components/unified-boq-items-table.test.ts 'src/app/(authenticated)/boqs/[id]/page.test.ts'
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts' src/components/unified-boq-items-table.tsx src/components/unified-boq-items-table.test.ts
git commit -m "feat(boq): keep identity drafts local during row actions"
```

**Acceptance:** Unsaved edits no longer block listed row/catalog actions; unrelated immediate mutations preserve drafts; custom units survive reload through the API.

**Reviewer gate:** Inspect every former `mutationBusy` consumer and verify each replacement is intentionally scoped.

---

### Task 6: Deferred delete queue and sticky action rail

**Files:**

- Create: `src/lib/serial-task-queue.ts`
- Create: `src/lib/serial-task-queue.test.ts`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Modify: `src/app/(authenticated)/boqs/[id]/page.test.ts`
- Modify: `src/components/unified-boq-items-table.tsx`
- Modify: `src/components/unified-boq-items-table.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**

- Produces:

```ts
export interface SerialTaskQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>
}

export function createSerialTaskQueue(): SerialTaskQueue
```

- Delete stash:

```ts
type StashedDelete = {
  identityKey: string
  draft?: BoqDetailEdits[string]
}
```

- Existing DELETE endpoint remains unchanged.

- [ ] **Step 1: Write a failing serial-queue test**

`src/lib/serial-task-queue.test.ts`:

```ts
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
```

- [ ] **Step 2: Add failing delete and rail contracts**

Page tests:

```ts
test('stashes only the deleted row draft and serializes final commits', () => {
  assert.match(source, /takeBoqDetailDraft/)
  assert.match(source, /restoreBoqDetailDraft/)
  assert.match(source, /createSerialTaskQueue/)
  assert.match(source, /resolveBoqItemIdentityKey/)
  assert.doesNotMatch(source, /Save pending changes before deleting an item/)
  assert.doesNotMatch(source, /pending\.sectionIndex === row\.sectionIndex/)
})

test('keeps the idempotent six-second Sonner finalizer', () => {
  assert.match(source, /duration:\s*6000/)
  assert.match(source, /label:\s*"Undo"/)
  assert.match(source, /onAutoClose:\s*finalize/)
  assert.match(source, /onDismiss:\s*finalize/)
  assert.match(source, /if \(undone \|\| committed\) return/)
})
```

Table/CSS tests:

```ts
test('renders a sticky 40px delete rail without dropping columns', () => {
  assert.match(tableSource, /unified-boq-action-rail/)
  assert.match(globalsSource, /\.unified-boq-action-rail[^}]*position:\s*sticky/)
  assert.match(globalsSource, /\.unified-boq-action-rail[^}]*right:\s*0/)
  assert.match(globalsSource, /width:\s*40px/)
  assert.match(globalsSource, /@media \(hover:\s*none\)/)
  assert.match(globalsSource, /pointer:\s*coarse/)
})
```

- [ ] **Step 3: Verify tests fail**

```bash
npx tsx --test src/lib/serial-task-queue.test.ts src/components/unified-boq-items-table.test.ts 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: FAIL.

- [ ] **Step 4: Implement the failure-tolerant queue**

```ts
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
```

- [ ] **Step 5: Stage deletion by identity and draft**

At click:

1. Reject only read-only or invalid-identity rows.
2. Call `takeBoqDetailDraft`.
3. Update `editsRef`/state with the remaining map.
4. Add a stash keyed by stable identity.
5. Hide by identity.
6. Show **Item deleted** with six-second Undo.

Undo must remove only that stash and restore only `stash.draft`.

The toast finalizer enqueues:

```ts
void deleteQueueRef.current
  .enqueue(() => runCanonicalMutation(
    () => commitDeleteRef.current(stash),
  ))
  .catch(() => undefined)
```

Keep `undone` and `committed` guards shared between `onAutoClose` and `onDismiss`.

- [ ] **Step 6: Resolve the latest location at commit time**

Immediately before DELETE:

```ts
const resolution = resolveBoqItemIdentityKey(
  boqRef.current.sections,
  stash.identityKey,
)

if (resolution.status !== 'found') {
  throw new Error(
    'The item no longer has a unique location in this BOQ.',
  )
}

const response = await fetch(
  `/api/boqs/${encodeURIComponent(boqRef.current.id)}/items`,
  {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sectionIndex: resolution.location.sectionIndex,
      ...getBoqItemRequestIdentity(resolution.location.item),
    }),
  },
)
```

On success:

- Apply the returned BOQ through stable reconciliation.
- Remove the stash.
- Do not alter unrelated drafts.

On any failure:

- Remove the stash so the canonical row reappears.
- Restore `stash.draft`.
- Show the server or identity error.
- Let the serial queue continue.

`pendingDeletes` must not disable the table. Approval alone may inspect its length in Task 7.

- [ ] **Step 7: Implement the sticky delete rail**

Use `className="unified-boq-action-rail"` on the header, informational cell, and priced-row action cell. Keep section `colSpan={9}`.

Wrap delete buttons in Base UI Tooltip primitives imported from `@base-ui/react/tooltip`:

```tsx
<TooltipPrimitive.Root>
  <TooltipPrimitive.Trigger
    render={
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="unified-boq-delete-button"
        aria-label={`Delete item: ${row.item.desc}`}
        onClick={() => onDelete(row)}
      />
    }
  >
    <Trash2 aria-hidden="true" />
  </TooltipPrimitive.Trigger>
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Positioner side="left" sideOffset={6}>
      <TooltipPrimitive.Popup className="boq-row-action-tooltip">
        Delete item
      </TooltipPrimitive.Popup>
    </TooltipPrimitive.Positioner>
  </TooltipPrimitive.Portal>
</TooltipPrimitive.Root>
```

Wrap the table once in `TooltipPrimitive.Provider delay={350}`.

- [ ] **Step 8: Add desktop, keyboard, touch, and card CSS**

Desktop requirements:

```css
.unified-boq-action-rail {
  position: sticky;
  right: 0;
  z-index: 2;
  width: 40px;
  min-width: 40px;
  max-width: 40px;
  background: var(--surface);
  box-shadow: -18px 0 18px -18px rgba(4, 14, 32, 0.24);
}

.unified-boq-items-table thead .unified-boq-action-rail {
  z-index: 3;
  background: color-mix(in oklab, var(--muted) 50%, var(--surface));
}

.unified-boq-delete-button {
  width: 32px;
  min-width: 32px;
  height: 32px;
  opacity: 0;
  color: var(--muted-text);
  transition: opacity 120ms ease, color 120ms ease, background 120ms ease;
}

.unified-boq-items-table tbody tr:hover .unified-boq-delete-button,
.unified-boq-action-rail:focus-within .unified-boq-delete-button,
.unified-boq-delete-button:focus-visible {
  opacity: 1;
}

.unified-boq-delete-button:hover,
.unified-boq-delete-button:focus-visible {
  color: var(--danger);
  background: color-mix(in oklab, var(--danger) 9%, transparent);
}

@media (hover: none), (pointer: coarse) {
  .unified-boq-delete-button {
    opacity: 1;
  }
}
```

At `max-width: 920px`, card rows no longer use the desktop sticky-cell layout. The action cell becomes a visible full-width, right-aligned card row, with the button always visible. Preserve the current two-column and one-column card contracts.

Add tooltip portal styling and include rail/button/tooltip transitions in reduced-motion handling.

- [ ] **Step 9: Run focused tests**

```bash
npx tsx --test src/lib/serial-task-queue.test.ts src/lib/boq-detail-state.test.ts src/components/unified-boq-items-table.test.ts 'src/app/(authenticated)/boqs/[id]/page.test.ts'
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/serial-task-queue.ts src/lib/serial-task-queue.test.ts 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts' src/components/unified-boq-items-table.tsx src/components/unified-boq-items-table.test.ts src/app/globals.css
git commit -m "feat(boq): serialize undoable row deletion"
```

**Acceptance:** Multiple pending deletions resolve their latest section serially; failures restore the row and its draft; unrelated actions remain available; rail stays visible and accessible.

**Reviewer gate:** Exercise two rapid deletes conceptually against section pruning, inspect failure restoration, and verify hover is not the only reveal mechanism.

---

### Task 7: Unsaved status and approve-saved-version warning

**Files:**

- Create: `src/components/ui/alert-dialog.tsx`
- Modify: `src/app/(authenticated)/boqs/[id]/page.tsx`
- Modify: `src/app/(authenticated)/boqs/[id]/page.test.ts`
- Modify: `src/app/globals.css`

**Interfaces:**

- Produces styled wrappers around `@base-ui/react/alert-dialog`.
- Page adds:
  - `approveWarningOpen`
  - `requestApproval()`
  - `approveSavedVersion()`
- No API changes.

- [ ] **Step 1: Add failing approval source contracts**

In the page test:

```ts
test('approval warns about drafts but approves only saved data', () => {
  assert.match(source, /Approve saved version\?/)
  assert.match(
    source,
    /unsaved change\(s\) will not be included and will be discarded\./,
  )
  assert.match(source, />Cancel</)
  assert.match(source, />Approve saved version</)
  assert.match(
    source,
    /body:\s*JSON\.stringify\(\{\s*status:\s*['"]approved['"]\s*\}\)/,
  )
  assert.doesNotMatch(source, /Save pending changes before approving/)
  assert.match(
    source,
    /applyMutationBoq\([\s\S]*?\{\s*force:\s*true\s*\}/,
  )
})

test('drafts clear only inside the successful approval path', () => {
  const successIndex = source.indexOf(
    'BOQ approved and linked to the Standard Catalog',
  )
  const clearEditsIndex = source.lastIndexOf(
    'replaceEdits({})',
    successIndex,
  )
  const catchIndex = source.indexOf('catch (error)', successIndex)

  assert.ok(clearEditsIndex > -1)
  assert.ok(clearEditsIndex < catchIndex)
})

test('shows unsaved status without disabling approval solely for drafts', () => {
  assert.match(source, />Unsaved changes</)
  assert.doesNotMatch(
    source,
    /disabled=\{[^}]*pendingChanges[^}]*\}[^>]*>\s*\{approving/,
  )
})

test('revalidates blockers and establishes a synchronous approval barrier', () => {
  assert.match(source, /approvalBlockedReason/)
  assert.match(source, /approvalBarrierRef\.current = true/)
  assert.match(source, /activeCanonicalMutationsRef/)
  assert.match(source, /editingDisabled=\{saving \|\| approving\}/)
  assert.match(source, /approvalBarrierRef\.current = false/)
})
```

- [ ] **Step 2: Verify tests fail**

```bash
npx tsx --test 'src/app/(authenticated)/boqs/[id]/page.test.ts'
```

Expected: FAIL.

- [ ] **Step 3: Add Base UI alert-dialog wrappers**

Create `src/components/ui/alert-dialog.tsx` with 2-space indentation and styles matching `ui/dialog.tsx`, using:

```ts
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog'
```

Export:

```ts
AlertDialog
AlertDialogClose
AlertDialogContent
AlertDialogDescription
AlertDialogFooter
AlertDialogHeader
AlertDialogTitle
```

`AlertDialogContent` must render `AlertDialogPrimitive.Portal`, Backdrop, then Popup. Use an explicitly forwarded close-button ref so the page’s safe initial-focus target type-checks:

```tsx
const AlertDialogClose = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof AlertDialogPrimitive.Close>
>(function AlertDialogClose(props, ref) {
  return (
    <AlertDialogPrimitive.Close
      ref={ref}
      data-slot="alert-dialog-close"
      {...props}
    />
  )
})

function AlertDialogContent({
  className,
  ...props
}: AlertDialogPrimitive.Popup.Props) {
  return (
    <AlertDialogPrimitive.Portal>
      <AlertDialogPrimitive.Backdrop
        data-slot="alert-dialog-overlay"
        className="fixed inset-0 z-50 bg-black/10 backdrop-blur-xs"
      />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(
          "dialog-content fixed left-1/2 top-1/2 z-50 grid w-full max-w-sm gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none",
          className,
        )}
        {...props}
      />
    </AlertDialogPrimitive.Portal>
  )
}
```

`AlertDialogContent` therefore accepts the Base UI popup `initialFocus` prop so the page can focus the safe **Cancel** button. Add the Root, Description, Header, Footer, and Title wrappers using their corresponding Base UI/React prop types and the same slot/class conventions. Do not modify the existing generic Dialog wrapper.

- [ ] **Step 4: Split request and execution of approval**

Add:

```ts
const [approveWarningOpen, setApproveWarningOpen] = useState(false)
const approveCancelRef = useRef<HTMLButtonElement>(null)
```

Create one `approvalBlockedReason(): string | null` helper that reads `isReadOnly`, `approving`, the current saved verification/catalog blockers, `pendingDeletes.length`, `saving`, `addingItem`, `activeCanonicalMutationsRef.current`, `catalogModalBusy`, `excludeBusy`, `includingItemKeys.size`, and `deletingBoq`. It does not inspect `pendingChanges` or `invalidDraftKeys` because those local values are intentionally excluded from saved-version approval.

`requestApproval`:

1. Reject read-only/in-flight approval.
2. Call `approvalBlockedReason()` and show its message when non-null. Active/pending actions use **Wait for current BOQ actions to finish before approving.**
3. If `pendingChanges > 0`, open the warning.
4. Otherwise call `approveSavedVersion()` directly.

The warning may remain open while the user continues ordinary work, so `approveSavedVersion()` must call `approvalBlockedReason()` again synchronously on confirmation. If blocked, keep the warning open, show the reason, and do not set the barrier or send PUT.

`approveSavedVersion`:

```ts
const blockedReason = approvalBlockedReason()
if (blockedReason) {
  toast.error(blockedReason)
  return
}

setApproveWarningOpen(false)
approvalBarrierRef.current = true
setApproving(true)
try {
  await runCanonicalMutation(async () => {
    const response = await fetch(
      `/api/boqs/${encodeURIComponent(boqRef.current.id)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'approved' }),
      },
    )
    if (!response.ok) {
      throw new Error(
        await readError(response, 'Failed to approve BOQ'),
      )
    }

    applyMutationBoq(
      await response.json() as Boq,
      { force: true },
    )
  })
  replaceEdits({})
  replaceMetadataEdits({})
  invalidDraftRef.current = new Set()
  setInvalidDraftKeys(new Set())
  toast.success('BOQ approved and linked to the Standard Catalog')
} catch (error) {
  toast.error(
    error instanceof Error ? error.message : 'Failed to approve BOQ',
  )
} finally {
  approvalBarrierRef.current = false
  setApproving(false)
}
```

Set the ref before `setApproving(true)` so event handlers stop synchronously before React rerenders. Because `approvalBlockedReason()` ran immediately beforehand and the barrier blocks every new canonical mutation, the approval response is the sole in-flight BOQ mutation and may be force-applied safely before drafts clear or success is reported. While `approving`, pass `editingDisabled={saving || approving}` and `catalogDisabled={approving}`, disable metadata, add/include/delete/exclude/manual-match controls, and keep Save disabled. This barrier prevents newer, unwarned drafts or mutations from being created and then erased by the successful approval clear. No draft-clearing call belongs before the successful response; failure leaves all snapshots untouched.

- [ ] **Step 5: Render exact warning and unsaved status**

Alert dialog:

```tsx
<AlertDialog
  open={approveWarningOpen}
  onOpenChange={(open) => {
    if (!approving) setApproveWarningOpen(open)
  }}
>
  <AlertDialogContent initialFocus={approveCancelRef}>
    <AlertDialogHeader>
      <AlertDialogTitle>Approve saved version?</AlertDialogTitle>
      <AlertDialogDescription>
        {pendingChanges} unsaved change(s) will not be included and will be discarded.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogClose
        ref={approveCancelRef}
        render={<Button type="button" variant="outline" />}
      >
        Cancel
      </AlertDialogClose>
      <Button
        type="button"
        onClick={() => void approveSavedVersion()}
      >
        Approve saved version
      </Button>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

Beside **Save draft**, render when `pendingChanges > 0`:

```tsx
<span className="boq-unsaved-status" role="status" aria-live="polite">
  <span className="boq-unsaved-dot" aria-hidden="true" />
  Unsaved changes
</span>
```

Approve-button disabled state may include only:

- `approving`
- `pendingDeletes.length > 0`
- the immediate-mutation conditions listed in `requestApproval`
- verification blockers
- catalog-readiness blockers
- read-only state through conditional rendering

It must not include `pendingChanges` or invalid local draft keys.

- [ ] **Step 6: Style status and reduced motion**

Use a small amber dot and muted amber text without increasing header height materially. Include alert-dialog and unsaved-dot animation/transition selectors in reduced-motion handling.

- [ ] **Step 7: Run all focused tests**

```bash
npx tsx --test src/lib/units.test.ts src/lib/settings-storage.test.ts src/lib/workspace-unit-storage.test.ts src/app/api/settings/units/units-api.test.ts src/lib/workspace-units-client.test.ts src/components/unit-combobox.test.ts src/lib/boq-item-identity.test.ts src/lib/boq-detail-state.test.ts src/lib/boq-unified-rows.test.ts src/lib/serial-task-queue.test.ts src/components/unified-boq-items-table.test.ts 'src/app/(authenticated)/boqs/[id]/page.test.ts'
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/ui/alert-dialog.tsx 'src/app/(authenticated)/boqs/[id]/page.tsx' 'src/app/(authenticated)/boqs/[id]/page.test.ts' src/app/globals.css
git commit -m "feat(boq): approve the saved version explicitly"
```

**Acceptance:** Approval warning uses alert-dialog semantics and safe initial focus; failure preserves drafts; success discards them only after approving the saved BOQ.

**Reviewer gate:** Confirm the request body cannot include draft data, invalid local drafts do not block saved-version approval, and pending delete still prevents approval of unsettled state.

---

## Final Validation

- [ ] **Run the complete project check**

```bash
npm run check
```

Expected: ESLint, TypeScript, and the complete test suite PASS.

- [ ] **Update Graphify**

```bash
graphify update .
```

Expected: graph update completes; dirty `graphify-out/` output is expected and should not be committed unless repository policy already tracks the updated files.

- [ ] **Inspect the final diff**

```bash
git status --short
git diff --check
git diff --stat main...HEAD
git log --oneline main..HEAD
```

Acceptance:

- Seven scoped implementation commits, plus reviewer-fix commits if needed.
- No changes to `catalog-match-modal.tsx` or `ui/dialog.tsx`.
- No migration or Settings management UI.
- No positional draft-key construction.
- No broad `mutationBusy`.

- [ ] **Browser QA at desktop width**

Use an authenticated BOQ detail page.

1. Confirm headers remain Description, Unit, Qty, Rate, Material, Labour, Total, Catalog, rail.
2. Horizontally scroll; the 40px rail stays at the visible right edge.
3. Hover and keyboard-focus delete; tooltip and danger treatment appear.
4. Tab to a visually hidden delete button; it reveals on focus.
5. Open Unit menus near each viewport edge; confirm collision flipping and no clipping.
6. Exercise Arrow keys, Home/End, Enter, Escape, outside click, and focus return.
7. Scroll the unit option list without closing it.
8. Scroll the BOQ table or resize; confirm the menu closes safely.

- [ ] **Workspace-unit QA**

1. Add a new unit and confirm the row shows **Unsaved changes**.
2. Reload without saving the BOQ; the row returns to its saved unit, but the new unit remains available.
3. Open another BOQ and confirm the unit is available.
4. If a second authenticated workspace session is available, confirm the unit appears there after reload.
5. Add the same unit with different casing; confirm no duplicate.
6. Simulate POST failure; typed text and inline error remain.

- [ ] **Draft/action/delete QA**

1. Edit two rows without saving.
2. Run AI suggest, accept/dismiss, Find/Change match, Exclude, Include optional, metadata edit, and Add missing item; unrelated drafts remain.
3. Delete a drafted row and Undo; its draft returns.
4. Delete it again and wait six seconds; only that draft disappears.
5. Start two deletes quickly, including items whose deletion prunes a section; both commits resolve correctly.
6. Force one DELETE failure; its row/draft returns while the other deletion remains valid.
7. Force metadata save success followed by item PATCH failure; confirm both local draft sets remain visible, then retry successfully.
8. Delay two overlapping canonical mutations so response arrival and `updatedAt` order disagree; confirm the idle authoritative GET wins.
9. Start a new canonical mutation while that refresh GET is in flight; confirm the overtaken refresh is discarded and the next idle refresh wins.
10. Save remaining drafts and reload to confirm only explicit Save persisted them.

- [ ] **Approval QA**

1. With drafts present, click **Approve BOQ**.
2. Verify exact warning copy and initial focus on **Cancel**.
3. Cancel and confirm drafts remain.
4. Retry, force approval failure, and confirm drafts remain.
5. Retry successfully; confirm only the previously saved version is approved and all local drafts disappear.
6. Open the approval warning, start a catalog/include action, then confirm; revalidation must block approval until the action settles.
7. Return an approval response whose `updatedAt` is older/equal-conflicting with the local ref; confirm the barrier-protected response is applied, read-only approved state renders, and only then are drafts cleared and success shown.
8. Confirm approval is unavailable during an active delete Undo window.

- [ ] **Responsive, touch, and motion QA**

At approximately 920px and 520px:

- Table cards retain every data field.
- Delete is always visible on touch/coarse pointers.
- Unit menu stays within 8px viewport gutters.
- Card action row is right aligned and reachable.
- Reduced-motion mode suppresses nonessential popover, tooltip, and rail transitions.

- [ ] **Whole-branch review**

Dispatch fresh reviewers for:

1. Stable identity/draft/delete correctness.
2. Settings transaction/auth/error handling.
3. Tests and validation completeness.
4. Combobox, sticky rail, responsive behavior, accessibility, and approved visual contract.

Apply accepted fixes with one fresh fix Worker, rerun affected focused tests and `npm run check`, then repeat focused review if fixes are substantial.

## Dependencies

- Task 2 depends on Task 1.
- Task 3 depends on Task 1.
- Task 4 is independently implementable after the worktree baseline.
- Task 5 depends on Tasks 2, 3, and 4.
- Task 6 depends on Tasks 4 and 5.
- Task 7 depends on Tasks 5 and 6.
- Final validation depends on all seven task reviewer gates passing.

## Risks

- Firestore transaction mocks can give false confidence if production reads outside the transaction; reviewer must inspect the adapter directly.
- Base UI portal interactions cannot be fully exercised by the current SSR harness; browser QA is mandatory.
- Existing legacy BOQs may contain missing or duplicate codes. The design requires explicit row locking/error, not positional fallback.
- Multiple server mutations can return close together. `runCanonicalMutation`, the epoch/overlap coordinator, idle authoritative refresh, `boqRef.current`, and identity reconciliation must remain one application boundary; stale closures or an overtaken force-refresh are regression risks.
- Component-cost local validity state must be cleared after successful approval but must not block approving the saved version.
- Sticky table cells behave differently once the responsive table becomes cards; desktop and both responsive breakpoints require direct inspection.
- The catalog-match dialog is deliberately unchanged; any diff to it is scope expansion.
