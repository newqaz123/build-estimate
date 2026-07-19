import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { uploadRejectionMessage } from './boq-upload'

test('upload rejection messages give actionable type and size guidance', () => {
  assert.equal(uploadRejectionMessage(['file-invalid-type']), 'Choose a PDF file. Other file types are not supported.')
  assert.equal(uploadRejectionMessage(['file-too-large']), 'Choose a PDF smaller than 20 MB.')
  assert.equal(uploadRejectionMessage(['too-many-files']), 'Choose one PDF at a time.')
  assert.equal(uploadRejectionMessage(['unknown']), 'Choose one PDF smaller than 20 MB.')
})

test('import route wires independent BOQ and extraction-run IDs to the Firestore adapter', () => {
  const source = readFileSync(new URL('../app/api/boqs/import/route.ts', import.meta.url), 'utf8')
  assert.match(source, /createFirestoreExtractionStore/)
  assert.match(source, /createRunId:\s*\(\)\s*=>\s*crypto\.randomUUID\(\)/)
  assert.match(source, /now:\s*\(\)\s*=>\s*new Date\(\)/)
})
