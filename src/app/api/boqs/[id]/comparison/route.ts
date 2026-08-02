import { auth } from '@/lib/auth'
import { getDocument, queryCollection } from '@/lib/db'
import type { Boq } from '@/lib/boq-schema'
import type { StandardEntry } from '@/lib/standard-schema'
import { createComparisonGetHandler } from './handler'

export const GET = createComparisonGetHandler({
  authenticate: auth,
  loadBoqs: async () => (
    await queryCollection<Boq>('boqs')
  ).docs,
  loadStandards: async () => (
    await queryCollection<StandardEntry>('standards')
  ).docs,
  loadUnitMap: async () => {
    const settings = await getDocument<{
      fuzzy?: {
        unitMap?: Record<string, string>
      }
    }>('settings', 'workspace')

    return settings?.fuzzy?.unitMap ?? {}
  },
})
