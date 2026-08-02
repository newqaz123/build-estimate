import type { Boq } from "@/lib/boq-schema"

export function resolveCompareBoqId(
  boqs: readonly Pick<Boq, "id">[],
  preferredId: string | null | undefined,
  currentId: string,
): string {
  if (preferredId && boqs.some((boq) => boq.id === preferredId)) {
    return preferredId
  }

  if (currentId && boqs.some((boq) => boq.id === currentId)) {
    return currentId
  }

  return boqs[0]?.id ?? ""
}
