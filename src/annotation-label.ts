/** Keep generated source names readable even through legacy Windows encodings. */
export function annotationTrackLabel(label: string, assembly: string): string {
  return `${repairAnnotationLabel(label).replace(/\s*\u00b7\s*/g, ' - ')} (${assembly})`
}

/** Repair only the known UTF-8-as-Latin-1 separator artifact, never decode arbitrary names. */
export function repairAnnotationLabel(label: string): string {
  return label.replace(/\u00c2+(?=[\u00b7\u00a0])/g, '').replace(/\u00a0/g, ' ')
}
