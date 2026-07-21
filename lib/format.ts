export function eur(n: number): string {
  const v = Math.round(n)
  const s = Math.abs(v).toLocaleString('en-US')
  return v < 0 ? `-\u20AC${s}` : `\u20AC${s}`
}

export function eur1(n: number): string {
  const s = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  })
  return n < 0 ? `-\u20AC${s}` : `\u20AC${s}`
}

export function pct(n: number): string {
  return `${n.toFixed(1)}%`
}
