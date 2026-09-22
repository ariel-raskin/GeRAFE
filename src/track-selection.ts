export function groupSelection(
  currentIds: ReadonlySet<string>,
  memberIds: readonly string[],
  additive: boolean,
): Set<string> {
  if (!memberIds.length) return new Set(currentIds)
  const next = additive ? new Set(currentIds) : new Set<string>()
  const allSelected = memberIds.every((id) => currentIds.has(id))
  if (additive && allSelected) for (const id of memberIds) next.delete(id)
  else for (const id of memberIds) next.add(id)
  return next
}
