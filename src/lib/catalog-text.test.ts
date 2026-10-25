import assert from 'node:assert/strict'
import test from 'node:test'

import {
  builtinUnit,
  compareSpecTokens,
  extractSpecTokens,
  normalizeThai,
  segmentThaiWords,
} from './catalog-text'

test('unit synonyms resolve case- and punctuation-insensitively', () => {
  const groups: Record<string, string[]> = {
    ea: ['ea', 'EA', 'No.', 'no', 'pcs', 'PC', 'ตัว', 'ชิ้น', 'อัน'],
    set: ['set', 'Sets', 'ชุด'],
    lot: ['lot', 'Lot.', 'LS', 'L/S', 'l.s.', 'เหมา', 'Job'],
    m: ['m', 'M.', 'เมตร', 'ม.', 'ม'],
    m2: ['m2', 'M2.', 'm²', 'sq.m', 'SQM', 'sq m', 'ตร.ม.', 'ตารางเมตร'],
    m3: ['m3', 'ลบ.ม.', 'cu.m', 'CU M'],
    kg: ['kg', 'KG.', 'กก.'],
    bag: ['ถุง', 'bag', 'Bags'],
  }
  for (const [canonical, variants] of Object.entries(groups)) {
    for (const variant of variants) assert.equal(builtinUnit(variant), canonical, variant)
  }
  assert.equal(builtinUnit('ton'), null)
})

test('Thai text is NFC with marks kept and sara am recomposed', () => {
  assert.equal(normalizeThai('ท\u0e48อ'), 'ท่อ')
  assert.equal(normalizeThai('น\u0e4d\u0e32'), 'นำ')
  assert.equal(normalizeThai('\u0e01\u0e4d\u0e32'), normalizeThai('\u0e01\u0e33'))
})

test('Thai runs are split into words with Intl.Segmenter', () => {
  const words = segmentThaiWords('ค่าขนส่งวัสดุ pipe').split(' ')
  assert.ok(words.includes('ค่า'))
  assert.ok(words.includes('ขนส่ง'))
  assert.ok(words.includes('pipe'))
  assert.ok(words.every((word) => !/^[\u0e30-\u0e3a\u0e47-\u0e4e]/.test(word)), 'no word starts with a dangling mark')
})

test('pipe sizes agree across B, inch marks, inch words, Thai, DN and JIS A', () => {
  const sizes = ['Pipe 2B', 'Pipe 2"', 'pipe 2 inch', 'ท่อ 2 นิ้ว', 'Pipe DN50', 'Pipe 50A', 'Pipe 2 in']
    .map((text) => extractSpecTokens(text).size)
  assert.deepEqual(new Set(sizes), new Set(['2']))
  assert.equal(extractSpecTokens('Valve 1-1/2B').size, '1.5')
  assert.equal(extractSpecTokens('Valve 1/2"').size, '0.5')
  assert.equal(extractSpecTokens('Bolt M16x50L').size, 'm16')
})

test('reducers keep both sizes and match regardless of order', () => {
  assert.equal(extractSpecTokens('Reducer 4B x 2B').size, '4x2')
  assert.equal(extractSpecTokens('Reducer 4x2').size, '4x2')
  assert.equal(extractSpecTokens('Reducer DN100 x DN50').size, '4x2')
  const result = compareSpecTokens(extractSpecTokens('reducer 2" x 4"'), extractSpecTokens('Reducer 4B x 2B'))
  assert.deepEqual(result.conflicts, [])
  assert.deepEqual(result.agreements, ['size'])
})

test('specs: material, schedule, thickness, rebar, rating and process', () => {
  assert.deepEqual(extractSpecTokens('Pipe SUS304 Sch40 ERW 2B'), {
    material: 'sus304', schedule: '40', process: 'erw', size: '2',
  })
  assert.equal(extractSpecTokens('pipe sch 10S').schedule, '10s')
  assert.equal(extractSpecTokens('SUS 316L').material, 'sus316l')
  assert.equal(extractSpecTokens('Plate SS400').material, 'ss400')
  assert.equal(extractSpecTokens('Sheet THK 0.47mm').thickness, '0.47')
  assert.equal(extractSpecTokens('แผ่น หนา 0.47 มม.').thickness, '0.47')
  assert.equal(extractSpecTokens('Gasket 2B x 3t').thickness, '3')
  assert.equal(extractSpecTokens('Rebar DB12 + RB9').rebar, 'db12+rb9')
  assert.equal(extractSpecTokens('Flange JIS10K-FF').rating, '10k')
  assert.equal(extractSpecTokens('Valve 1" CL#800').rating, 'class800')
  assert.equal(extractSpecTokens('Channel 100 x 50 x 5t').dims, '100x50')
  assert.equal(extractSpecTokens('Sch 40 1/2"').size, '0.5')
})

test('conflicting specs are reported per category', () => {
  const result = compareSpecTokens(
    extractSpecTokens('Elbow SUS304 Sch10S 2 inch'),
    extractSpecTokens('Elbow SUS316 Sch10S 4B'),
  )
  assert.deepEqual(result.conflicts.sort(), ['material', 'size'])
  assert.deepEqual(result.agreements, ['schedule'])
})
