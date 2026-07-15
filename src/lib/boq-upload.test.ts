import assert from 'node:assert/strict'
import test from 'node:test'
import { uploadRejectionMessage } from './boq-upload'

test('upload rejection messages give actionable type and size guidance', () => {
  assert.equal(uploadRejectionMessage(['file-invalid-type']), 'Choose a PDF file. Other file types are not supported.')
  assert.equal(uploadRejectionMessage(['file-too-large']), 'Choose a PDF smaller than 20 MB.')
  assert.equal(uploadRejectionMessage(['too-many-files']), 'Choose one PDF at a time.')
  assert.equal(uploadRejectionMessage(['unknown']), 'Choose one PDF smaller than 20 MB.')
})
