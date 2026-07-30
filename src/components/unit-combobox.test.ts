import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnitCombobox } from './unit-combobox'

const source = readFileSync(
  new URL('./unit-combobox.tsx', import.meta.url),
  'utf8',
)

const baseProps = {
  units: ['m³', 'm²', 'ton'],
  onChange: () => undefined,
  onAddUnit: async (unit: string) => unit,
}

test('renders a trigger button showing the current unit, not a bare input', () => {
  const html = renderToStaticMarkup(createElement(UnitCombobox, { ...baseProps, value: 'm³' }))
  assert.match(html, /<button[^>]*unit-combobox-trigger/)
  assert.match(html, /unit-combobox-value/)
  assert.match(html, />m³</)
})

test('renders a placeholder and the disabled attribute when empty/disabled', () => {
  const html = renderToStaticMarkup(createElement(UnitCombobox, { ...baseProps, value: '', disabled: true }))
  assert.match(html, /Unit…/)
  assert.match(html, /disabled/)
})

test('readOnly renders plain text and no trigger', () => {
  const html = renderToStaticMarkup(createElement(UnitCombobox, { ...baseProps, value: 'ton', readOnly: true }))
  assert.match(html, /unit-combobox-readonly/)
  assert.match(html, />ton</)
  assert.doesNotMatch(html, /unit-combobox-trigger/)
})

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
