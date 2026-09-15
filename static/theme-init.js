try {
  const currentKey = 'gerafe-theme'
  const legacyKey = 'locus-glide-theme'
  const current = localStorage.getItem(currentKey)
  const saved = current ?? localStorage.getItem(legacyKey)
  if (current === null && saved !== null) localStorage.setItem(currentKey, saved)
  const theme = saved === 'light' || saved === 'dark'
    ? saved
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
} catch {
  document.documentElement.dataset.theme = 'dark'
  document.documentElement.style.colorScheme = 'dark'
}
