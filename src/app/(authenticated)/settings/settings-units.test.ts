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
