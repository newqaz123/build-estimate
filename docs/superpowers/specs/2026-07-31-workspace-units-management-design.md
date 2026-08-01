# Workspace Units management — design

Date: 2026-07-31
Branch: `feat/boq-detail-controls-refinement`
Status: design (pending approval)

## Goal

Add a master-list management surface for workspace units so users can **Add, Rename, and Delete** custom units — not just create them inline from a BOQ row. Lives as a new inline **Units** section on the existing Settings page. Standard units remain read-only.

## Background / data model (recap)

- BOQs are documents in the `boqs` collection. Each has `sections: BoqSection[]`; each section has `items: BoqItem[]`.
- `BoqPricedItem.unit: string` is the **editable** unit shown/edited in the BOQ table.
- `BoqPricedItem.sourceUnit` and `BoqSourceCost.unit` are **immutable provenance** — never touched by this feature.
- Custom units are stored as a `customUnits: string[]` array on the workspace settings document (`WORKSPACE_SETTINGS_ID`). Standard units are the hardcoded `STANDARD_UNITS` in `src/lib/units.ts`.
- There is **no foreign key** between BOQ items and the unit list — both are plain strings.

## Decisions (confirmed)

1. **Delete in-use guard:** block delete if any BOQ item in the workspace uses the unit; surface the usage count. (Fail-closed, matches codebase style.)
2. **Rename scope:** cascade — rewrite `unit` on every priced item across all BOQs where `unit === oldUnit`, in one transaction. Provenance fields untouched.
3. **Delete UX:** confirm via `AlertDialog`. If the unit is in use, the dialog shows a blocked "N items use this — reassign them first" state.
4. **Layout:** inline **Units** section inside the existing Settings page (matches the Vendors/prompts pattern). Full CRUD inline.
5. **Add:** the section has a full Add form (input + "Add unit"), sharing the existing `normalizeNewUnit` validation. The inline BOQ combobox "Add workspace unit" stays as a convenience shortcut.
6. **Entry points:** the new Settings "Units" section, plus a **"Manage units…"** link at the bottom of the BOQ Unit combobox dropdown that navigates to `/settings#units` (scrolls to / highlights the section).

## Out of scope

- Reordering / categorising units.
- Bulk operations beyond the single rename cascade.
- Migrating `sourceUnit`/`sourceCosts.*.unit` provenance.
- Splitting Settings into sub-routes.
- Changes to standard units (`STANDARD_UNITS`) — always read-only.

## Backend

### Pure helpers — `src/lib/units.ts` (TDD)

- `removeWorkspaceUnit(existing: readonly string[], unit: string): string[]`
  - Returns a new array without `unit`. Throws `WorkspaceUnitError` (404) if `unit` is not present in `existing`.
  - Standard units are not in `customUnits`, so removing a standard unit is naturally a 404 — no special case needed.
- `renameWorkspaceUnit(existing: readonly string[], oldUnit: string, newUnit: string): { customUnits: string[] }`
  - Throws `WorkspaceUnitError` (404) if `oldUnit` not in `existing`.
  - Normalises `newUnit` via `normalizeNewUnit(existing without oldUnit, newUnit)`; throws on empty / duplicate / over-length / control-char.
  - Returns the new array with `oldUnit` replaced by the normalised `newUnit` (preserving order at `oldUnit`'s position).

### Usage mapping — `src/lib/units.ts`

- `countUnitUsage(boqs: readonly Boq[], unit: string): number`
  - Walks `sections[].items[]`, counts **priced** items (`pricingRole !== 'bundle_child'`) whose `unit === unit`.
  - Pure; tested with fixture BOQs.

### Atomic storage — `src/lib/workspace-unit-storage.ts`

Mirrors the existing `createWorkspaceUnitStore(runAtomic)` injection pattern for testability. Adds:

- `removeWorkspaceUnitAtomically(unit: string): Promise<{ customUnits: string[] }>`
  - Single small transaction: read settings → `removeWorkspaceUnit(customUnits, unit)` → write. **Does not** compute usage (that is the handler's job, see API).
  - Handler flow: call `countWorkspaceUnitUsage(unit)` first; if `> 0` → return 409 **without** any write; else run `removeWorkspaceUnitAtomically`. This keeps the remove transaction tiny and avoids a write-then-rollback.

- `renameWorkspaceUnitAtomically(oldUnit: string, newUnit: string): Promise<{ customUnits: string[]; updatedBoqs: number; updatedItems: number }>`
  - **One transaction** that:
    1. reads the settings doc, applies `renameWorkspaceUnit` to `customUnits`;
    2. reads every BOQ in `boqs` (via the transaction's `db` handle);
    3. for each BOQ with ≥1 priced item whose `unit === oldUnit`, stages `transaction.update(boqRef, { sections: rewrittenSections, updatedAt })` — only the `unit` field on matching items changes;
    4. returns counts.
  - Uses a cascade-capable injection adapter so the concurrency/rewrite is unit-testable without Firestore:
    ```
    interface WorkspaceUnitCascadeDocument {
      readSettings(): Promise<unknown | null>
      writeSettings(patch: Record<string, unknown>): void
      readAllBoqs(): Promise<Array<{ id: string; data: unknown }>>
      writeBoq(id: string, patch: Record<string, unknown>): void
    }
    type CascadeRunner = <T>(work: (doc: WorkspaceUnitCascadeDocument) => Promise<T>) => Promise<T>
    ```
  - Production adapter wraps `runTransaction((tx, db) => …)`; test adapter is in-memory.

### Usage scan helper — `src/lib/workspace-unit-storage.ts`

- `countWorkspaceUnitUsage(unit: string): Promise<number>` — reads all BOQs and runs `countUnitUsage`. Used by the DELETE pre-check and the GET response.

### API routes — `src/app/api/settings/units/route.ts`

Adds to the existing `POST`:

- `GET` (auth required) → `200 { standardUnits: string[]; customUnits: string[]; usage: Record<string, number> }`
  - `usage` maps each **custom** unit to its BOQ-item count (standard units omitted).
- `DELETE` `{ unit: string }` (auth required):
  - 400 if body invalid / `unit` not a non-empty string.
  - Compute usage; **409** `{ error, usageCount }` if `usageCount > 0`.
  - Else atomic remove → `200 { customUnits: string[] }`.
  - 401 unauthenticated, 500 on backend error (generic, non-leaking — same pattern as POST).
- `PATCH` `{ oldUnit: string; newUnit: string }` (auth required):
  - 400 if body invalid.
  - Cascade rename → `200 { customUnits: string[]; updatedItems: number }`.
  - 409 if `oldUnit` not custom / `newUnit` invalid or collides (`WorkspaceUnitError`).
  - 401/500 as above.

Handler logic lives in `src/app/api/settings/units/handler.ts` (factory pattern, auth-injected) so request/auth/validation behaviour is unit-testable without Firestore, matching the existing `POST` handler.

## Frontend

### Client — `src/lib/workspace-units-client.ts`

Adds (mirroring existing `addWorkspaceUnit`):
- `fetchWorkspaceUnitsOverview()` → `GET` → `{ standardUnits, customUnits, usage }`. Throws readable error on non-ok/malformed.
- `removeWorkspaceUnit(unit)` → `DELETE`; on 409 throws an error carrying `usageCount`.
- `renameWorkspaceUnit(oldUnit, newUnit)` → `PATCH` → `{ customUnits, updatedItems }`.

### Settings Units section — `src/app/(authenticated)/settings/page.tsx`

New section `data-od-id="workspace-units-settings"` with `id="units"` (hash target), placed after the "Catalog fuzzy rules" section. Contains:

- **Header:** "Workspace units" + dirty/unsaved indicator when relevant.
- **Standard units:** read-only badge list (with a subtle "Standard" tag).
- **Add form:** a text input + "Add unit" button. On submit → `addWorkspaceUnit` (existing client fn) → refresh overview; show toast; reject duplicates/empties with inline validation mirroring `normalizeNewUnit`.
- **Custom units list:** one row per custom unit:
  - the unit string;
  - a usage badge ("N items") from `usage`;
  - **Rename** (inline edit: click edit → input prefilled → Save/Cancel; on save → `renameWorkspaceUnit` → refresh + toast "Renamed; updated N items");
  - **Delete** (opens `AlertDialog` confirm showing the unit name and usage; confirm → `removeWorkspaceUnit`; if the API returns 409, the dialog switches to the blocked "N items use this — reassign them first" state with only a Close button).

Optimistic UI is avoided for rename/delete (they mutate shared workspace state); a per-row busy state disables only that row's actions during the request.

### BOQ combobox entry point — `src/components/unit-combobox.tsx`

Below the existing "Add workspace unit" affordance, add a **"Manage units…"** link/button that navigates to `/settings#units` (closes the combobox first). It is purely navigational.

## Concurrency & safety

- Rename cascade runs in **one Firestore transaction** (settings + all affected BOQs). Bounded by Firestore transaction limits — acceptable at prototype scale (tens of BOQs). Noted as a known constraint; if BOQ volume grows, chunking will be needed.
- Delete pre-checks usage **before** the remove transaction; the remove transaction itself only touches the settings doc. A race (item becomes used between check and remove) is tolerable because the remove only edits the settings list — BOQ items keep their string and are not corrupted.
- All mutations are server-authoritative; the client refreshes the overview after each mutation.
- Auth/backend errors are generic and non-leaking (existing POST pattern).

## Testing (TDD, 2-space indent)

- `src/lib/units.ts`: `removeWorkspaceUnit` (missing → throw), `renameWorkspaceUnit` (missing/empty/duplicate/over-length/order-preserving), `countUnitUsage` (priced only, multi-section, ignores provenance fields).
- `src/lib/workspace-unit-storage.ts`: atomic remove concurrency; cascade rename rewrites only matching priced items, leaves `sourceUnit`/`sourceCosts` untouched, updates `updatedAt`, counts correctly; in-memory cascade adapter.
- `src/app/api/settings/units/handler.ts` (+ `route.ts`): GET auth + shape; DELETE 400/401/409-usage/200/500; PATCH 400/401/409/200/500; auth-backend rejection → generic 500.
- `src/lib/workspace-units-client.ts`: overview fetch + malformed; remove 409 → `usageCount`; rename happy path.
- Settings page: source-contract test asserting the Units section renders Add form + custom rows + standard badges, and that `id="units"` / `data-od-id` anchors exist.
- `npm run check` must pass (lint + tsc + tests). No production migrations.

## Risks / open items

- Cascade transaction size at very high BOQ volume (deferred; noted above).
- Usage scan reads all BOQs on Settings load (acceptable for prototype; can be cached later).
