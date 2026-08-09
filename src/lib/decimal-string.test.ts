import assert from 'node:assert/strict'
import test from 'node:test'

import {
  divideDecimalExact,
  equalAtMinorUnit,
  multiplyDecimal,
  parseDecimalString,
} from './decimal-string'

test('normalizes quantity and component rates without changing total', () => {
  const quantity = multiplyDecimal('6', '6')
  const materialRate = divideDecimalExact('6000', '6', 6)
  assert.equal(quantity, '36')
  assert.equal(materialRate, '1000')
  assert.equal(equalAtMinorUnit('36000', multiplyDecimal(quantity, materialRate), 2), true)
})

test('rejects exponent notation and zero divisors', () => {
  assert.throws(() => parseDecimalString('1e3'))
  assert.throws(() => divideDecimalExact('1', '0', 6))
})

test('parseDecimalString canonicalizes trailing zeros and negative zero', () => {
  assert.equal(parseDecimalString('1.5000'), '1.5')
  assert.equal(parseDecimalString('10.00'), '10')
  assert.equal(parseDecimalString('-0'), '0')
  assert.equal(parseDecimalString('-0.000'), '0')
  assert.equal(parseDecimalString('0.0'), '0')
  assert.equal(parseDecimalString('-12.3400'), '-12.34')
})

test('parseDecimalString rejects unsafe and noncanonical numeric input', () => {
  for (const value of [
    '',
    ' ',
    ' 1',
    '1 ',
    '.',
    '-',
    '+',
    '+1',
    '01',
    '01.2',
    '1.',
    '.5',
    '1..2',
    '1e3',
    '1E3',
    '1e-3',
    'NaN',
    'Infinity',
    '-Infinity',
    '0x10',
    '1_000',
    '1,000',
    null,
    undefined,
    true,
    false,
    1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    BigInt(10),
    {},
    [],
  ]) {
    assert.throws(() => parseDecimalString(value), /decimal|invalid|numeric/i)
  }
})

test('multiplyDecimal uses exact scale arithmetic and canonical output', () => {
  assert.equal(multiplyDecimal('1.5', '2'), '3')
  assert.equal(multiplyDecimal('0.1', '0.2'), '0.02')
  assert.equal(multiplyDecimal('-1.5', '2'), '-3')
  assert.equal(multiplyDecimal('-1.5', '-2'), '3')
  assert.equal(multiplyDecimal('0', '99.99'), '0')
})

test('divideDecimalExact divides to the requested scale without floating point', () => {
  assert.equal(divideDecimalExact('1', '3', 6), '0.333333')
  assert.equal(divideDecimalExact('1', '3', 2), '0.33')
  assert.equal(divideDecimalExact('2', '3', 2), '0.67')
  assert.equal(divideDecimalExact('10', '4', 1), '2.5')
  assert.equal(divideDecimalExact('10', '4', 0), '3')
  assert.equal(divideDecimalExact('-10', '4', 2), '-2.5')
  assert.equal(divideDecimalExact('100', '6', 6), '16.666667')
})

test('divideDecimalExact rejects zero and negative conversion factors', () => {
  assert.throws(() => divideDecimalExact('1', '0', 6))
  assert.throws(() => divideDecimalExact('1', '-0', 6))
  assert.throws(() => divideDecimalExact('1', '-2', 6))
  assert.throws(() => divideDecimalExact('1', '0.0', 6))
})

test('divideDecimalExact rejects invalid scale', () => {
  assert.throws(() => divideDecimalExact('1', '2', -1))
  assert.throws(() => divideDecimalExact('1', '2', 1.5))
  assert.throws(() => divideDecimalExact('1', '2', Number.NaN))
})

test('equalAtMinorUnit compares at the currency minor-unit boundary', () => {
  // half-away-from-zero: 10.004 -> 10.00, 10.005 -> 10.01
  assert.equal(equalAtMinorUnit('10.004', '10.001', 2), true)
  assert.equal(equalAtMinorUnit('10.005', '10.014', 2), true)
  assert.equal(equalAtMinorUnit('10.004', '10.005', 2), false)
  assert.equal(equalAtMinorUnit('1.005', '1.005', 3), true)
  assert.equal(equalAtMinorUnit('1.004', '1.005', 3), false)
  assert.equal(equalAtMinorUnit('10', '10.00'), true)
  // half-away-from-zero on negatives: -1.005 and -1.014 both become -1.01
  assert.equal(equalAtMinorUnit('-1.005', '-1.014', 2), true)
  assert.equal(equalAtMinorUnit('-1.005', '-1.004', 2), false)
})

test('conversion preserves total across quantity scale-up and rate scale-down', () => {
  const factor = parseDecimalString('6')
  const quantity = multiplyDecimal('6', factor)
  const materialRate = divideDecimalExact('6000', factor, 6)
  const labourRate = divideDecimalExact('3000', factor, 6)
  const normalizedMaterialTotal = multiplyDecimal(quantity, materialRate)
  assert.equal(quantity, '36')
  assert.equal(materialRate, '1000')
  assert.equal(labourRate, '500')
  const combinedRate = parseDecimalString('1500')
  assert.equal(
    equalAtMinorUnit(
      '54000',
      multiplyDecimal(quantity, combinedRate),
      2,
    ),
    true,
  )
  assert.equal(equalAtMinorUnit('36000', normalizedMaterialTotal, 2), true)
})
