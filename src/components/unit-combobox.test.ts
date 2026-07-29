import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { UnitCombobox } from './unit-combobox'

const baseProps = { units: ['m³', 'm²', 'ton'], onChange: () => undefined, onAddUnit: () => undefined }

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
