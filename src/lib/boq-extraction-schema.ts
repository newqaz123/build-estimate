import type {
  BoqEntryOrigin,
  BoqExtractionWarning,
  BoqSourceCosts,
  BoqSourceRef,
  WorkType,
} from './boq-schema'

const WORK_TYPES: readonly WorkType[] = ['Structural', 'MEP', 'Finishing', 'Unclassified']
const V2_ITEM_TYPES = ['unit', 'lump_sum'] as const
const COST_COMPONENTS = ['material', 'labour', 'combined', 'lump_sum'] as const
const PRICING_ROLES = ['standard', 'bundle_parent', 'bundle_child'] as const
const ENTRY_ORIGINS: readonly BoqEntryOrigin[] = ['docling', 'ai_accepted', 'user']
const CLASSIFICATIONS = ['header', 'section', 'item', 'continuation', 'total', 'option', 'note', 'unknown'] as const
export const BOQ_RECONCILIATION_TOLERANCE = 0.01

interface ExactDecimal {
  coefficient: bigint
  scale: number
}

const BIGINT_ZERO = BigInt(0)
const BIGINT_ONE = BigInt(1)
const BIGINT_TEN = BigInt(10)

function exactDecimal(value: number): ExactDecimal {
  const text = value.toString().toLowerCase()
  const negative = text.startsWith('-')
  const unsigned = negative ? text.slice(1) : text
  const [mantissa, exponentText] = unsigned.split('e')
  const exponent = exponentText === undefined ? 0 : Number(exponentText)
  const point = mantissa.indexOf('.')
  const fractionDigits = point === -1 ? 0 : mantissa.length - point - 1
  const digits = mantissa.replace('.', '')
  let coefficient = BigInt(digits) * (negative ? -BIGINT_ONE : BIGINT_ONE)
  let scale = fractionDigits - exponent
  if (scale < 0) {
    coefficient *= BIGINT_TEN ** BigInt(-scale)
    scale = 0
  }
  while (scale > 0 && coefficient % BIGINT_TEN === BIGINT_ZERO) {
    coefficient /= BIGINT_TEN
    scale -= 1
  }
  return { coefficient, scale }
}

const MAX_FINITE_DECIMAL = exactDecimal(Number.MAX_VALUE)
const DECIMAL_TOLERANCE = exactDecimal(BOQ_RECONCILIATION_TOLERANCE)

function alignDecimals(left: ExactDecimal, right: ExactDecimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale)
  return [
    left.coefficient * BIGINT_TEN ** BigInt(scale - left.scale),
    right.coefficient * BIGINT_TEN ** BigInt(scale - right.scale),
    scale,
  ]
}

function addDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const [leftCoefficient, rightCoefficient, scale] = alignDecimals(left, right)
  return { coefficient: leftCoefficient + rightCoefficient, scale }
}

function subtractDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const [leftCoefficient, rightCoefficient, scale] = alignDecimals(left, right)
  return { coefficient: leftCoefficient - rightCoefficient, scale }
}

function multiplyDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return { coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale }
}

function decimalsEqual(left: ExactDecimal, right: ExactDecimal): boolean {
  const [leftCoefficient, rightCoefficient] = alignDecimals(left, right)
  return leftCoefficient === rightCoefficient
}

function absoluteWithinTolerance(value: ExactDecimal): boolean {
  const [coefficient, tolerance] = alignDecimals(
    { coefficient: value.coefficient < BIGINT_ZERO ? -value.coefficient : value.coefficient, scale: value.scale },
    DECIMAL_TOLERANCE,
  )
  return coefficient <= tolerance
}

function absoluteAtMost(left: ExactDecimal, right: ExactDecimal): boolean {
  const [leftCoefficient, rightCoefficient] = alignDecimals(
    { coefficient: left.coefficient < BIGINT_ZERO ? -left.coefficient : left.coefficient, scale: left.scale },
    { coefficient: right.coefficient < BIGINT_ZERO ? -right.coefficient : right.coefficient, scale: right.scale },
  )
  return leftCoefficient <= rightCoefficient
}

function numbersExactlyEqual(left: number, right: number): boolean {
  return decimalsEqual(exactDecimal(left), exactDecimal(right))
}

function checkedFloatRoundTrip(value: ExactDecimal, path: string): { number: number; decimal: ExactDecimal } {
  if (!absoluteAtMost(value, MAX_FINITE_DECIMAL)) invalid(path, 'remain within the finite JSON-number range')
  const serialized = Number(`${value.coefficient}e-${value.scale}`)
  if (!Number.isFinite(serialized)) invalid(path, 'remain within the finite JSON-number range')
  return { number: serialized, decimal: exactDecimal(serialized) }
}

type V2ItemType = typeof V2_ITEM_TYPES[number]
export type BoqCostComponent = typeof COST_COMPONENTS[number]
export type BoqPricingRole = typeof PRICING_ROLES[number]
export type BoqSourceRowClassification = typeof CLASSIFICATIONS[number]

export interface DoclingMetadataField<T extends string = string> {
  value: T
  confidence: number
  source: string
}

export interface DoclingMetadata {
  vendor: DoclingMetadataField
  project: DoclingMetadataField
  date: DoclingMetadataField
  workType: DoclingMetadataField<WorkType>
}

export interface DoclingItemV2 {
  id: string
  desc: string
  unit: string
  qty: number
  rate: number
  total: number
  type: V2ItemType
  costComponent: BoqCostComponent
  sourceRef: BoqSourceRef
  sourceCosts?: BoqSourceCosts | null
}

export interface DoclingSectionV2 {
  header: string
  items: DoclingItemV2[]
}

export interface DoclingRawTable {
  page: number
  table: number
  rows: unknown[][]
}

export interface DoclingResultV2 {
  contractVersion: 2
  documentName: string
  pageCount: number
  documentText: string
  tables: DoclingRawTable[]
  sections: DoclingSectionV2[]
  metadata: DoclingMetadata
  warnings: BoqExtractionWarning[]
  sourceTotal?: number | null
  totalItems: number
}

export interface DoclingRawCellV3 {
  column: number
  rawText: string
  lines: string[]
  rowSpan: number
  columnSpan: number
  startRowOffset: number
  endRowOffset: number
  startColumnOffset: number
  endColumnOffset: number
  columnHeader: boolean
  rowHeader: boolean
  rowSection: boolean
  carried: boolean
}

export interface DoclingWarningV3 {
  code: string
  message: string
  sourceRef?: BoqSourceRef
}

export interface BoqSourceRowV3 {
  id: string
  page: number
  table: number
  row: number
  section: string | null
  headers: string[]
  rawCells: DoclingRawCellV3[]
  rawText: string
  classification: BoqSourceRowClassification
  confidence: number
  warnings: DoclingWarningV3[]
}

export interface DoclingSourceCostV3 {
  qty: number
  unit: string
  rate: number
  total: number
}

export interface DoclingSourceCostsV3 {
  material: DoclingSourceCostV3
  labour: DoclingSourceCostV3
}

interface DerivedItemV3Common {
  id: string
  desc: string
  sourceRowIds: string[]
  optional: boolean
  excludedFromTotal: boolean
  exclusionReason?: string | null
  entryOrigin: BoqEntryOrigin
}

export interface DerivedPricedItemV3 extends DerivedItemV3Common {
  pricingRole: 'standard' | 'bundle_parent'
  parentBundleId?: null
  costComponent: BoqCostComponent
  sourceCosts?: DoclingSourceCostsV3 | null
  unit: string
  qty: number
  rate: number
  total: number
}

export interface DerivedBundleChildV3 extends DerivedItemV3Common {
  pricingRole: 'bundle_child'
  parentBundleId: string
  costComponent?: null
  sourceCosts?: null
  unit?: null
  qty?: null
  rate?: null
  total?: null
}

export type DerivedItemV3 = DerivedPricedItemV3 | DerivedBundleChildV3

export interface DoclingSectionV3 {
  header: string
  items: DerivedItemV3[]
}

export interface DoclingReconciliationV3 {
  itemTotal: number
  sourceTotal: number | null
  reconciled: boolean
  difference: number
}

export interface DoclingResultV3 {
  contractVersion: 3
  documentName: string
  pageCount: number
  documentText: string
  sourceRows: BoqSourceRowV3[]
  sections: DoclingSectionV3[]
  metadata: DoclingMetadata
  warnings: DoclingWarningV3[]
  sourceTotal?: number | null
  reconciliation: DoclingReconciliationV3
  totalItems: number
}

export type DoclingResult = DoclingResultV2 | DoclingResultV3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(path: string, expectation: string): never {
  throw new TypeError(`Invalid Docling result: ${path} must be ${expectation}`)
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(path, 'an object')
  return value
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) invalid(path, `contain no unknown field ${JSON.stringify(unknown)}`)
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, 'an array')
  return value
}

function string(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) {
    invalid(path, nonEmpty ? 'a non-empty string' : 'a string')
  }
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'a boolean')
  return value
}

function finite(value: unknown, path: string, nonNegative = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(path, 'a finite number')
  if (nonNegative && value < 0) invalid(path, 'a finite non-negative number')
  return value
}

function integer(value: unknown, path: string, minimum: number): number {
  const parsed = finite(value, path)
  if (!Number.isInteger(parsed) || parsed < minimum) invalid(path, `an integer greater than or equal to ${minimum}`)
  return parsed
}

function enumeration<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid(path, `one of ${values.join(', ')}`)
  return value as T
}

function nullableString(value: unknown, path: string): string | null | undefined {
  if (value === undefined || value === null) return value
  return string(value, path)
}

function sourceRef(value: unknown, path: string, strict = false): BoqSourceRef {
  const ref = record(value, path)
  if (strict) exactKeys(ref, ['page', 'table', 'row'], path)
  return {
    page: integer(ref.page, `${path}.page`, 1),
    table: integer(ref.table, `${path}.table`, 1),
    row: integer(ref.row, `${path}.row`, 1),
  }
}

function confidence(value: unknown, path: string): number {
  const parsed = finite(value, path)
  if (parsed < 0 || parsed > 1) invalid(path, 'between 0 and 1')
  return parsed
}

function metadata(value: unknown, path: string, strict: boolean): DoclingMetadata {
  const input = record(value, path)
  if (strict) exactKeys(input, ['vendor', 'project', 'date', 'workType'], path)
  const field = <T extends string>(candidate: unknown, fieldPath: string, values?: readonly T[]): DoclingMetadataField<T> => {
    const item = record(candidate, fieldPath)
    if (strict) exactKeys(item, ['value', 'confidence', 'source'], fieldPath)
    return {
      value: values ? enumeration(item.value, values, `${fieldPath}.value`) : string(item.value, `${fieldPath}.value`) as T,
      confidence: confidence(item.confidence, `${fieldPath}.confidence`),
      source: string(item.source, `${fieldPath}.source`),
    }
  }
  return {
    vendor: field(input.vendor, `${path}.vendor`),
    project: field(input.project, `${path}.project`),
    date: field(input.date, `${path}.date`),
    workType: field(input.workType, `${path}.workType`, WORK_TYPES),
  }
}

function warning(value: unknown, path: string, strict: boolean): DoclingWarningV3 {
  const input = record(value, path)
  if (strict) exactKeys(input, ['code', 'message', 'sourceRef'], path)
  return {
    code: string(input.code, `${path}.code`),
    message: string(input.message, `${path}.message`),
    ...(input.sourceRef === undefined || input.sourceRef === null
      ? {}
      : { sourceRef: sourceRef(input.sourceRef, `${path}.sourceRef`, strict) }),
  }
}

function parseV2(value: Record<string, unknown>): DoclingResultV2 {
  const tables = array(value.tables, 'tables').map((candidate, tableIndex): DoclingRawTable => {
    const input = record(candidate, `tables[${tableIndex}]`)
    return {
      page: integer(input.page, `tables[${tableIndex}].page`, 0),
      table: integer(input.table, `tables[${tableIndex}].table`, 0),
      rows: array(input.rows, `tables[${tableIndex}].rows`).map((row, rowIndex) =>
        array(row, `tables[${tableIndex}].rows[${rowIndex}]`)),
    }
  })
  const sections = array(value.sections, 'sections').map((candidate, sectionIndex): DoclingSectionV2 => {
    const input = record(candidate, `sections[${sectionIndex}]`)
    return {
      header: string(input.header, `sections[${sectionIndex}].header`),
      items: array(input.items, `sections[${sectionIndex}].items`).map((candidateItem, itemIndex): DoclingItemV2 => {
        const path = `sections[${sectionIndex}].items[${itemIndex}]`
        const item = record(candidateItem, path)
        const costs = item.sourceCosts === undefined || item.sourceCosts === null
          ? item.sourceCosts as null | undefined
          : parseLegacyCosts(item.sourceCosts, `${path}.sourceCosts`)
        return {
          id: string(item.id, `${path}.id`, true),
          desc: string(item.desc, `${path}.desc`),
          unit: string(item.unit, `${path}.unit`),
          qty: finite(item.qty, `${path}.qty`),
          rate: finite(item.rate, `${path}.rate`),
          total: finite(item.total, `${path}.total`),
          type: enumeration(item.type, V2_ITEM_TYPES, `${path}.type`),
          costComponent: enumeration(item.costComponent, COST_COMPONENTS, `${path}.costComponent`),
          sourceRef: sourceRef(item.sourceRef, `${path}.sourceRef`),
          ...(costs === undefined ? {} : { sourceCosts: costs }),
        }
      }),
    }
  })
  return {
    contractVersion: 2,
    documentName: string(value.documentName, 'documentName'),
    pageCount: integer(value.pageCount, 'pageCount', 0),
    documentText: string(value.documentText, 'documentText'),
    tables,
    sections,
    metadata: metadata(value.metadata, 'metadata', false),
    warnings: array(value.warnings, 'warnings').map((item, index) => warning(item, `warnings[${index}]`, false)),
    ...(value.sourceTotal === undefined || value.sourceTotal === null
      ? value.sourceTotal === null ? { sourceTotal: null } : {}
      : { sourceTotal: finite(value.sourceTotal, 'sourceTotal') }),
    totalItems: integer(value.totalItems, 'totalItems', 0),
  }
}

function parseLegacyCosts(value: unknown, path: string): BoqSourceCosts {
  const input = record(value, path)
  const cost = (candidate: unknown, costPath: string) => {
    const item = record(candidate, costPath)
    if (typeof item.present !== 'boolean') invalid(`${costPath}.present`, 'a boolean')
    return {
      present: item.present,
      qty: finite(item.qty, `${costPath}.qty`),
      unit: string(item.unit, `${costPath}.unit`),
      rate: finite(item.rate, `${costPath}.rate`),
      total: finite(item.total, `${costPath}.total`),
    }
  }
  return { material: cost(input.material, `${path}.material`), labour: cost(input.labour, `${path}.labour`) }
}

function parseRawCell(value: unknown, path: string, sourceRowNumber: number): DoclingRawCellV3 {
  const input = record(value, path)
  exactKeys(input, [
    'column', 'rawText', 'lines', 'rowSpan', 'columnSpan',
    'startRowOffset', 'endRowOffset', 'startColumnOffset', 'endColumnOffset',
    'columnHeader', 'rowHeader', 'rowSection', 'carried',
  ], path)
  const result: DoclingRawCellV3 = {
    column: integer(input.column, `${path}.column`, 0),
    rawText: string(input.rawText, `${path}.rawText`),
    lines: array(input.lines, `${path}.lines`).map((line, index) => string(line, `${path}.lines[${index}]`)),
    rowSpan: integer(input.rowSpan, `${path}.rowSpan`, 1),
    columnSpan: integer(input.columnSpan, `${path}.columnSpan`, 1),
    startRowOffset: integer(input.startRowOffset, `${path}.startRowOffset`, 0),
    endRowOffset: integer(input.endRowOffset, `${path}.endRowOffset`, 1),
    startColumnOffset: integer(input.startColumnOffset, `${path}.startColumnOffset`, 0),
    endColumnOffset: integer(input.endColumnOffset, `${path}.endColumnOffset`, 1),
    columnHeader: boolean(input.columnHeader, `${path}.columnHeader`),
    rowHeader: boolean(input.rowHeader, `${path}.rowHeader`),
    rowSection: boolean(input.rowSection, `${path}.rowSection`),
    carried: boolean(input.carried, `${path}.carried`),
  }
  if (result.endRowOffset <= result.startRowOffset || result.rowSpan !== result.endRowOffset - result.startRowOffset) {
    invalid(`${path}.rowSpan`, 'match increasing row offsets')
  }
  if (result.endColumnOffset <= result.startColumnOffset || result.columnSpan !== result.endColumnOffset - result.startColumnOffset) {
    invalid(`${path}.columnSpan`, 'match increasing column offsets')
  }
  if (result.column !== result.startColumnOffset) invalid(`${path}.column`, 'match startColumnOffset')
  const offset = sourceRowNumber - 1
  if (offset < result.startRowOffset || offset >= result.endRowOffset) invalid(path, 'cover its source row offset')
  if (result.carried !== (result.startRowOffset !== offset)) invalid(`${path}.carried`, 'match row-span carry evidence')
  const expectedLines = result.rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (result.lines.length !== expectedLines.length || result.lines.some((line, index) => line !== expectedLines[index])) {
    invalid(`${path}.lines`, 'preserve rawText line breaks exactly')
  }
  return result
}

function parseSourceRow(value: unknown, path: string): BoqSourceRowV3 {
  const input = record(value, path)
  exactKeys(input, ['id', 'page', 'table', 'row', 'section', 'headers', 'rawCells', 'rawText', 'classification', 'confidence', 'warnings'], path)
  const rowNumber = integer(input.row, `${path}.row`, 1)
  const location = {
    page: integer(input.page, `${path}.page`, 1),
    table: integer(input.table, `${path}.table`, 1),
    row: rowNumber,
  }
  const rawText = string(input.rawText, `${path}.rawText`)
  const classification = enumeration(input.classification, CLASSIFICATIONS, `${path}.classification`)
  const cells = array(input.rawCells, `${path}.rawCells`)
  if (cells.length === 0 && (rawText !== '' || classification !== 'unknown')) {
    invalid(`${path}.rawCells`, 'be empty only for an empty unknown logical row')
  }
  const rawCells = cells.map((cell, index) => parseRawCell(cell, `${path}.rawCells[${index}]`, rowNumber))
  for (let index = 1; index < rawCells.length; index += 1) {
    const previous = rawCells[index - 1]
    const current = rawCells[index]
    if (
      current.startColumnOffset < previous.startColumnOffset
      || (current.startColumnOffset === previous.startColumnOffset && current.endColumnOffset < previous.endColumnOffset)
    ) {
      invalid(`${path}.rawCells`, 'remain in deterministic geometry order')
    }
  }
  const headers = array(input.headers, `${path}.headers`).map((header, index) => string(header, `${path}.headers[${index}]`))
  if (headers.length < Math.max(...rawCells.map((cell) => cell.endColumnOffset))) {
    invalid(`${path}.headers`, 'cover every raw-cell column')
  }
  const warnings = array(input.warnings, `${path}.warnings`).map((item, index) => {
    const parsed = warning(item, `${path}.warnings[${index}]`, true)
    if (parsed.sourceRef && locationKey(parsed.sourceRef) !== locationKey(location)) {
      invalid(`${path}.warnings[${index}].sourceRef`, 'match its row warning location')
    }
    return parsed
  })
  const expectedRawText = rawCells
    .filter((cell) => !cell.carried && cell.rawText !== '')
    .map((cell) => cell.rawText)
    .join(' | ')
  if (rawText !== expectedRawText) invalid(`${path}.rawText`, 'match ordered non-carried raw-cell evidence')
  return {
    id: string(input.id, `${path}.id`, true),
    ...location,
    section: input.section === undefined || input.section === null
      ? null
      : string(input.section, `${path}.section`),
    headers,
    rawCells,
    rawText,
    classification,
    confidence: confidence(input.confidence, `${path}.confidence`),
    warnings,
  }
}

function parseSourceCost(value: unknown, path: string): DoclingSourceCostV3 {
  const input = record(value, path)
  exactKeys(input, ['qty', 'unit', 'rate', 'total'], path)
  const result = {
    qty: finite(input.qty, `${path}.qty`, true),
    unit: string(input.unit, `${path}.unit`, true),
    rate: finite(input.rate, `${path}.rate`, true),
    total: finite(input.total, `${path}.total`, true),
  }
  if (!absoluteWithinTolerance(subtractDecimals(
    multiplyDecimals(exactDecimal(result.qty), exactDecimal(result.rate)),
    exactDecimal(result.total),
  ))) invalid(path, 'have quantity multiplied by rate match total')
  return result
}

function parseV3Item(value: unknown, path: string): DerivedItemV3 {
  const input = record(value, path)
  exactKeys(input, [
    'id', 'desc', 'pricingRole', 'sourceRowIds', 'parentBundleId', 'optional',
    'excludedFromTotal', 'exclusionReason', 'entryOrigin', 'costComponent',
    'sourceCosts', 'unit', 'qty', 'rate', 'total',
  ], path)
  const role = enumeration(input.pricingRole, PRICING_ROLES, `${path}.pricingRole`)
  const optional = input.optional === undefined ? false : boolean(input.optional, `${path}.optional`)
  const excluded = input.excludedFromTotal === undefined ? false : boolean(input.excludedFromTotal, `${path}.excludedFromTotal`)
  const exclusionReason = nullableString(input.exclusionReason, `${path}.exclusionReason`)
  const common = {
    id: string(input.id, `${path}.id`, true),
    desc: string(input.desc, `${path}.desc`, true),
    sourceRowIds: array(input.sourceRowIds, `${path}.sourceRowIds`).map((id, index) => string(id, `${path}.sourceRowIds[${index}]`, true)),
    optional,
    excludedFromTotal: excluded,
    ...(exclusionReason === undefined ? {} : { exclusionReason }),
    entryOrigin: input.entryOrigin === undefined ? 'docling' as const : enumeration(input.entryOrigin, ENTRY_ORIGINS, `${path}.entryOrigin`),
  }
  if (common.sourceRowIds.length === 0) invalid(`${path}.sourceRowIds`, 'contain at least one source row ID')
  if (excluded && !optional) invalid(`${path}.excludedFromTotal`, 'require optional to be true')
  if (excluded && (!exclusionReason || exclusionReason.length === 0)) invalid(`${path}.exclusionReason`, 'be present when excludedFromTotal is true')
  if (!excluded && exclusionReason !== undefined && exclusionReason !== null) invalid(`${path}.exclusionReason`, 'require excludedFromTotal to be true')

  if (role === 'bundle_child') {
    const pricedKeys = ['unit', 'qty', 'rate', 'total'] as const
    if (pricedKeys.some((key) => input[key] !== undefined && input[key] !== null)) invalid(path, 'not give bundle_child priced fields')
    if (input.parentBundleId === undefined || input.parentBundleId === null) invalid(`${path}.parentBundleId`, 'identify a bundle parent')
    if (input.costComponent !== undefined && input.costComponent !== null) invalid(`${path}.costComponent`, 'be absent for bundle_child')
    if (input.sourceCosts !== undefined && input.sourceCosts !== null) invalid(`${path}.sourceCosts`, 'be absent for bundle_child')
    if (excluded) invalid(`${path}.excludedFromTotal`, 'be false for bundle_child')
    return { ...common, pricingRole: role, parentBundleId: string(input.parentBundleId, `${path}.parentBundleId`, true) }
  }

  if (input.parentBundleId !== undefined && input.parentBundleId !== null) invalid(`${path}.parentBundleId`, 'be absent for priced items')
  const result: DerivedPricedItemV3 = {
    ...common,
    pricingRole: role,
    costComponent: enumeration(input.costComponent, COST_COMPONENTS, `${path}.costComponent`),
    unit: string(input.unit, `${path}.unit`, true),
    qty: finite(input.qty, `${path}.qty`, true),
    rate: finite(input.rate, `${path}.rate`, true),
    total: finite(input.total, `${path}.total`, true),
  }
  if (!absoluteWithinTolerance(subtractDecimals(
    multiplyDecimals(exactDecimal(result.qty), exactDecimal(result.rate)),
    exactDecimal(result.total),
  ))) invalid(path, 'have quantity multiplied by rate match total arithmetic')
  if (input.sourceCosts !== undefined && input.sourceCosts !== null) {
    const costsInput = record(input.sourceCosts, `${path}.sourceCosts`)
    exactKeys(costsInput, ['material', 'labour'], `${path}.sourceCosts`)
    const sourceCosts = {
      material: parseSourceCost(costsInput.material, `${path}.sourceCosts.material`),
      labour: parseSourceCost(costsInput.labour, `${path}.sourceCosts.labour`),
    }
    if (result.costComponent !== 'combined') invalid(`${path}.sourceCosts`, 'require the combined cost component')
    if (!absoluteWithinTolerance(subtractDecimals(
      addDecimals(exactDecimal(sourceCosts.material.total), exactDecimal(sourceCosts.labour.total)),
      exactDecimal(result.total),
    ))) {
      invalid(`${path}.sourceCosts`, 'have component totals sum to the priced item')
    }
    // Same-unit combined rows keep shared qty/unit/rate identity. Different
    // native component units stay on one priced line; /compare reads each
    // component's own unit/qty from sourceCosts.
    if (sourceCosts.material.unit === sourceCosts.labour.unit) {
      if (sourceCosts.material.unit !== result.unit) {
        invalid(`${path}.sourceCosts`, 'share the priced item unit')
      }
      if (!numbersExactlyEqual(sourceCosts.material.qty, sourceCosts.labour.qty)
        || !numbersExactlyEqual(sourceCosts.material.qty, result.qty)) {
        invalid(`${path}.sourceCosts`, 'share the priced item quantity')
      }
      if (!absoluteWithinTolerance(subtractDecimals(
        addDecimals(exactDecimal(sourceCosts.material.rate), exactDecimal(sourceCosts.labour.rate)),
        exactDecimal(result.rate),
      ))) {
        invalid(`${path}.sourceCosts`, 'have component rates sum to the priced item')
      }
    }
    result.sourceCosts = sourceCosts
  }
  return result
}

function locationKey(ref: BoqSourceRef): string {
  return `${ref.page}:${ref.table}:${ref.row}`
}

function parseV3(value: Record<string, unknown>): DoclingResultV3 {
  exactKeys(value, [
    'contractVersion', 'documentName', 'pageCount', 'documentText', 'sourceRows',
    'sections', 'metadata', 'warnings', 'sourceTotal', 'reconciliation', 'totalItems',
  ], 'result')
  const sourceRows = array(value.sourceRows, 'sourceRows').map((row, index) => parseSourceRow(row, `sourceRows[${index}]`))
  const rowIds = sourceRows.map((row) => row.id)
  if (new Set(rowIds).size !== rowIds.length) invalid('sourceRows', 'have unique source row IDs')
  const locations = sourceRows.map(locationKey)
  if (new Set(locations).size !== locations.length) invalid('sourceRows', 'have unique source row locations')
  const knownIds = new Set(rowIds)
  const knownLocations = new Set(locations)

  const sections = array(value.sections, 'sections').map((candidate, sectionIndex): DoclingSectionV3 => {
    const path = `sections[${sectionIndex}]`
    const input = record(candidate, path)
    exactKeys(input, ['header', 'items'], path)
    return {
      header: string(input.header, `${path}.header`),
      items: array(input.items, `${path}.items`).map((item, itemIndex) => parseV3Item(item, `${path}.items[${itemIndex}]`)),
    }
  })
  const items = sections.flatMap((section) => section.items)
  const itemIds = items.map((item) => item.id)
  if (new Set(itemIds).size !== itemIds.length) invalid('sections', 'have unique derived item IDs')
  for (const item of items) {
    if (new Set(item.sourceRowIds).size !== item.sourceRowIds.length) invalid(`derived item ${item.id}`, 'not repeat a source row ID')
    if (item.sourceRowIds.some((id) => !knownIds.has(id))) invalid(`derived item ${item.id}`, 'reference no unknown source row')
  }
  for (const section of sections) {
    const sectionItems = new Map(section.items.map((item) => [item.id, item]))
    for (const item of section.items) {
      if (item.pricingRole !== 'bundle_child') continue
      const parent = sectionItems.get(item.parentBundleId)
      if (!parent || parent.id === item.id || parent.pricingRole !== 'bundle_parent') {
        invalid(`bundle child ${item.id}`, 'reference a bundle parent in the same section')
      }
    }
  }

  const warnings = array(value.warnings, 'warnings').map((candidate, index) => warning(candidate, `warnings[${index}]`, true))
  for (const [index, item] of warnings.entries()) {
    if (item.sourceRef && !knownLocations.has(locationKey(item.sourceRef))) {
      invalid(`warnings[${index}].sourceRef`, 'reference a known source location')
    }
  }
  const sourceTotal = value.sourceTotal === undefined || value.sourceTotal === null
    ? value.sourceTotal as undefined | null
    : finite(value.sourceTotal, 'sourceTotal', true)
  const reconciliationInput = record(value.reconciliation, 'reconciliation')
  exactKeys(reconciliationInput, ['itemTotal', 'sourceTotal', 'reconciled', 'difference'], 'reconciliation')
  const reconciliation: DoclingReconciliationV3 = {
    itemTotal: finite(reconciliationInput.itemTotal, 'reconciliation.itemTotal', true),
    sourceTotal: reconciliationInput.sourceTotal === undefined || reconciliationInput.sourceTotal === null
      ? null
      : finite(reconciliationInput.sourceTotal, 'reconciliation.sourceTotal', true),
    reconciled: boolean(reconciliationInput.reconciled, 'reconciliation.reconciled'),
    difference: finite(reconciliationInput.difference, 'reconciliation.difference'),
  }
  const totalItems = integer(value.totalItems, 'totalItems', 0)
  const pricedItems = items.filter((item): item is DerivedPricedItemV3 => item.pricingRole !== 'bundle_child')
  if (totalItems !== pricedItems.length) invalid('totalItems', 'equal the number of priced derived items')
  let calculatedTotal: ExactDecimal = { coefficient: BIGINT_ZERO, scale: 0 }
  for (const item of pricedItems) {
    if (item.excludedFromTotal) continue
    calculatedTotal = addDecimals(calculatedTotal, exactDecimal(item.total))
    checkedFloatRoundTrip(calculatedTotal, 'reconciliation.itemTotal')
  }
  const serializedTotal = checkedFloatRoundTrip(calculatedTotal, 'reconciliation.itemTotal')
  if (!decimalsEqual(exactDecimal(reconciliation.itemTotal), serializedTotal.decimal)) {
    invalid('reconciliation.itemTotal', 'match the checked contributing-item total')
  }
  if (sourceTotal === undefined || sourceTotal === null) {
    if (reconciliation.sourceTotal !== null) invalid('reconciliation.sourceTotal', 'match absent sourceTotal')
  } else if (reconciliation.sourceTotal === null || !numbersExactlyEqual(sourceTotal, reconciliation.sourceTotal)) {
    invalid('reconciliation.sourceTotal', 'match sourceTotal')
  }
  const expectedDifference = sourceTotal === undefined || sourceTotal === null
    ? { coefficient: BIGINT_ZERO, scale: 0 }
    : subtractDecimals(serializedTotal.decimal, exactDecimal(sourceTotal))
  const serializedDifference = checkedFloatRoundTrip(expectedDifference, 'reconciliation.difference')
  if (!decimalsEqual(exactDecimal(reconciliation.difference), serializedDifference.decimal)) {
    invalid('reconciliation.difference', 'match the checked itemTotal minus sourceTotal')
  }
  const expectedReconciled = sourceTotal !== undefined
    && sourceTotal !== null
    && absoluteWithinTolerance(serializedDifference.decimal)
  if (reconciliation.reconciled !== expectedReconciled) invalid('reconciliation.reconciled', 'match deterministic reconciliation')

  return {
    contractVersion: 3,
    documentName: string(value.documentName, 'documentName'),
    pageCount: integer(value.pageCount, 'pageCount', 0),
    documentText: string(value.documentText, 'documentText'),
    sourceRows,
    sections,
    metadata: metadata(value.metadata, 'metadata', true),
    warnings,
    ...(sourceTotal === undefined ? {} : { sourceTotal }),
    reconciliation,
    totalItems,
  }
}

export function parseDoclingResult(value: unknown): DoclingResult {
  const result = record(value, 'result')
  if (result.contractVersion === 2) return parseV2(result)
  if (result.contractVersion === 3) return parseV3(result)
  invalid('contractVersion', 'exactly 2 or 3')
}
