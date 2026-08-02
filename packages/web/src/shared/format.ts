const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

const UNITS: { limit: number; divisor: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { limit: 60_000, divisor: 1_000, unit: 'second' },
  { limit: 3_600_000, divisor: 60_000, unit: 'minute' },
  { limit: 86_400_000, divisor: 3_600_000, unit: 'hour' },
  { limit: 604_800_000, divisor: 86_400_000, unit: 'day' },
  { limit: 2_629_800_000, divisor: 604_800_000, unit: 'week' },
  { limit: 31_557_600_000, divisor: 2_629_800_000, unit: 'month' },
]

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const elapsed = timestamp - now
  const magnitude = Math.abs(elapsed)

  for (const { limit, divisor, unit } of UNITS) {
    if (magnitude < limit) return RELATIVE.format(Math.round(elapsed / divisor), unit)
  }

  return RELATIVE.format(Math.round(elapsed / 31_557_600_000), 'year')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
