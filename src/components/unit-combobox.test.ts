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

test('invalidates stale add operations before they can update selection or state', () => {
  assert.match(source, /const addOperationGenerationRef = useRef\(0\)/)
  assert.match(
    source,
    /const operationGeneration = \+\+addOperationGenerationRef\.current/,
  )
  assert.match(
    source,
    /const invalidateAddOperation = useCallback\(\(\) => \{\s+addOperationGenerationRef\.current \+= 1/,
  )
  assert.match(
    source,
    /const closePopup = useCallback\(\(\) => \{\s+invalidateAddOperation\(\)/,
  )
  assert.match(
    source,
    /const selectUnit = useCallback\(\(unit: string\) => \{\s+invalidateAddOperation\(\)\s+onChange\(unit\)/,
  )
  assert.match(source, /const closeForLayoutChange = \(\) => closePopup\(\)/)
  assert.match(
    source,
    /onOpenChange=\{\(nextOpen\) => \{\s+if \(nextOpen\) setOpen\(true\)\s+else closePopup\(\)/,
  )
  assert.match(
    source,
    /catch \(error\) \{\s+if \(addOperationGenerationRef\.current === operationGeneration\) \{\s+setAddError/,
  )
  assert.match(
    source,
    /finally \{\s+if \(addOperationGenerationRef\.current === operationGeneration\) \{\s+setAddingUnit\(false\)/,
  )
  assert.match(
    source,
    /if \(addOperationGenerationRef\.current !== operationGeneration\) return\s+selectUnit\(canonical\)/,
  )
})

test('routes both selection paths through selectUnit rather than direct onChange', () => {
  // Browse selection from the Base UI listbox handler must go through selectUnit
  // so it invalidates any in-flight add operation before applying the selection.
  assert.match(
    source,
    /onValueChange=\{\(unit\) => \{\s+if \(!unit\) return\s+selectUnit\(unit\)/,
  )
  // The existing-canonical branch inside commitAdd must go through selectUnit
  // instead of calling onChange directly.
  assert.match(
    source,
    /if \(existingUnit\) \{\s+selectUnit\(existingUnit\)\s+return/,
  )
})
