export type DecimalString = string

interface ExactDecimal {
  /** Absolute coefficient digits; value = ± coefficient / 10^scale */
  coefficient: bigint
  scale: number
  negative: boolean
}

const BIGINT_ZERO = BigInt(0)
const BIGINT_ONE = BigInt(1)
const BIGINT_TWO = BigInt(2)
const BIGINT_TEN = BigInt(10)

class DecimalStringError extends TypeError {
  constructor(message: string) {
    super(message)
    this.name = 'DecimalStringError'
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && Number.isFinite(value)
    && value >= 0
}

function canonicalize(decimal: ExactDecimal): DecimalString {
  let { coefficient, scale } = decimal
  const { negative } = decimal
  if (coefficient < BIGINT_ZERO) {
    throw new DecimalStringError('Invalid internal decimal coefficient.')
  }

  while (scale > 0 && coefficient % BIGINT_TEN === BIGINT_ZERO) {
    coefficient /= BIGINT_TEN
    scale -= 1
  }

  if (coefficient === BIGINT_ZERO) {
    return '0'
  }

  const sign = negative ? '-' : ''
  const digits = coefficient.toString()
  if (scale === 0) {
    return `${sign}${digits}`
  }
  if (digits.length <= scale) {
    return `${sign}0.${'0'.repeat(scale - digits.length)}${digits}`
  }
  const wholeLength = digits.length - scale
  return `${sign}${digits.slice(0, wholeLength)}.${digits.slice(wholeLength)}`
}

function parseExact(value: unknown): ExactDecimal {
  if (typeof value !== 'string') {
    throw new DecimalStringError('Decimal value must be a canonical decimal string.')
  }
  if (value.length === 0) {
    throw new DecimalStringError('Decimal value must not be empty.')
  }

  // Reject exponent notation, infinities, NaN text, separators, and whitespace.
  if (/[eE_,\s]/.test(value) || /infinity/i.test(value) || /^nan$/i.test(value)) {
    throw new DecimalStringError('Decimal value contains unsafe or noncanonical numeric input.')
  }

  let offset = 0
  let negative = false
  if (value[offset] === '-') {
    negative = true
    offset += 1
  } else if (value[offset] === '+') {
    throw new DecimalStringError('Decimal value must not include an explicit plus sign.')
  }

  const body = value.slice(offset)
  if (body.length === 0) {
    throw new DecimalStringError('Decimal value must include digits.')
  }
  if (body.startsWith('.') || body.endsWith('.')) {
    throw new DecimalStringError('Decimal value must not start or end with a decimal point.')
  }
  if (!/^\d+(\.\d+)?$/.test(body)) {
    throw new DecimalStringError('Decimal value must be a canonical decimal string.')
  }

  const point = body.indexOf('.')
  const whole = point === -1 ? body : body.slice(0, point)
  const fraction = point === -1 ? '' : body.slice(point + 1)

  // Reject noncanonical leading zeros ("01", "00.1") while allowing "0" and "0.x".
  if (whole.length > 1 && whole.startsWith('0')) {
    throw new DecimalStringError('Decimal value must not include leading zeros.')
  }

  const scale = fraction.length
  const rawDigits = `${whole}${fraction}`
  const coefficient = BigInt(rawDigits)

  if (coefficient === BIGINT_ZERO) {
    return { coefficient: BIGINT_ZERO, scale: 0, negative: false }
  }

  return { coefficient, scale, negative }
}

/** Round half away from zero for a non-negative quotient + remainder. */
function roundHalfAwayFromZero(quotient: bigint, remainder: bigint, divisor: bigint): bigint {
  if (remainder === BIGINT_ZERO) {
    return quotient
  }
  const doubled = remainder * BIGINT_TWO
  if (doubled >= divisor) {
    return quotient + BIGINT_ONE
  }
  return quotient
}

/**
 * Parse a canonical decimal string into a normalized DecimalString.
 * Rejects exponent notation, non-strings, empty input, and other unsafe forms.
 */
export function parseDecimalString(value: unknown): DecimalString {
  return canonicalize(parseExact(value))
}

/**
 * Add with exact integer scale alignment. Never uses floating-point arithmetic.
 */
export function addDecimal(left: DecimalString, right: DecimalString): DecimalString {
  const leftDecimal = parseExact(left)
  const rightDecimal = parseExact(right)
  const scale = Math.max(leftDecimal.scale, rightDecimal.scale)
  const leftSigned = (leftDecimal.negative ? -leftDecimal.coefficient : leftDecimal.coefficient)
    * (BIGINT_TEN ** BigInt(scale - leftDecimal.scale))
  const rightSigned = (rightDecimal.negative ? -rightDecimal.coefficient : rightDecimal.coefficient)
    * (BIGINT_TEN ** BigInt(scale - rightDecimal.scale))
  const sum = leftSigned + rightSigned
  return canonicalize({
    coefficient: sum < BIGINT_ZERO ? -sum : sum,
    scale,
    negative: sum < BIGINT_ZERO,
  })
}

export function multiplyDecimal(left: DecimalString, right: DecimalString): DecimalString {
  const leftDecimal = parseExact(left)
  const rightDecimal = parseExact(right)
  return canonicalize({
    coefficient: leftDecimal.coefficient * rightDecimal.coefficient,
    scale: leftDecimal.scale + rightDecimal.scale,
    negative: leftDecimal.negative !== rightDecimal.negative,
  })
}

/**
 * Divide with exact integer arithmetic, rounding half-away-from-zero to `scale`
 * fractional digits, then canonicalizing trailing zeros.
 * Rejects zero and negative divisors (conversion factors must be positive).
 */
export function divideDecimalExact(
  dividend: DecimalString,
  divisor: DecimalString,
  scale: number,
): DecimalString {
  if (!isNonNegativeInteger(scale)) {
    throw new DecimalStringError('Division scale must be a non-negative integer.')
  }

  const numerator = parseExact(dividend)
  const denominator = parseExact(divisor)

  if (denominator.coefficient === BIGINT_ZERO) {
    throw new DecimalStringError('Division by zero is not allowed.')
  }
  if (denominator.negative) {
    throw new DecimalStringError('Conversion factors and divisors must be positive.')
  }

  // (n_coef / 10^n_scale) / (d_coef / 10^d_scale) at `scale` fractional digits:
  // scaled = n_coef * 10^(scale + d_scale) / (d_coef * 10^n_scale)
  const scaledNumerator = numerator.coefficient * (BIGINT_TEN ** BigInt(scale + denominator.scale))
  const scaledDenominator = denominator.coefficient * (BIGINT_TEN ** BigInt(numerator.scale))
  const quotient = scaledNumerator / scaledDenominator
  const remainder = scaledNumerator % scaledDenominator
  const rounded = roundHalfAwayFromZero(quotient, remainder, scaledDenominator)

  return canonicalize({
    coefficient: rounded,
    scale,
    negative: numerator.negative && rounded !== BIGINT_ZERO,
  })
}

/**
 * Compare two decimals after rounding each to the currency minor-unit scale.
 * Defaults to 2 fractional digits.
 */
export function equalAtMinorUnit(
  left: DecimalString,
  right: DecimalString,
  currencyScale = 2,
): boolean {
  if (!isNonNegativeInteger(currencyScale)) {
    throw new DecimalStringError('Currency scale must be a non-negative integer.')
  }
  const leftRounded = divideDecimalExact(left, '1', currencyScale)
  const rightRounded = divideDecimalExact(right, '1', currencyScale)
  return leftRounded === rightRounded
}
