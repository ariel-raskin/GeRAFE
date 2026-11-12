export interface DropRow { id: string; height: number; displayGroupId?: string }
interface PaneTrack { id: string; displayGroupId?: string }

/** The drag preview and its destinations share the layout with lifted rows removed. */
export function trackDropPosition(visibleRows: readonly DropRow[], paneTracks: readonly PaneTrack[], movingIds: ReadonlySet<string>, pointerY: number, withinGroupId?: string): { insertionIndex: number; guideY: number } {
  const rows = visibleRows.filter((row) => !movingIds.has(row.id))
  const remaining = paneTracks.filter((track) => !movingIds.has(track.id))
  let index = rows.length, y = 0
  if (withinGroupId) {
    let lastGroupIndex = -1
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      if (row.displayGroupId === withinGroupId) {
        lastGroupIndex = i
        if (pointerY < y + row.height / 2) { index = i; break }
      }
      y += row.height
    }
    if (index === rows.length && lastGroupIndex >= 0) index = lastGroupIndex + 1
  } else {
    for (let i = 0; i < rows.length;) {
      const first = rows[i]!
      let next = i + 1, height = first.height
      while (first.displayGroupId && next < rows.length && rows[next]!.displayGroupId === first.displayGroupId) height += rows[next++]!.height
      if (pointerY < y + height / 2) { index = i; break }
      y += height; i = next
    }
  }
  const after = rows[index]
  // Collapsed stacks may hide the first group member; never insert into that group.
  const anchor = after?.displayGroupId && !withinGroupId
    ? remaining.find((track) => track.displayGroupId === after.displayGroupId) : after
  const insertionIndex = anchor ? remaining.findIndex((track) => track.id === anchor.id) : remaining.length
  return { insertionIndex: Math.max(0, insertionIndex), guideY: rows.slice(0, index).reduce((sum, row) => sum + row.height, 0) }
}
