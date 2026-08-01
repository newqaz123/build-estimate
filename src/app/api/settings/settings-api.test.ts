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
