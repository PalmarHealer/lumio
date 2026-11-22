import type { LyricLine } from './lyrics'

/** Each singer keeps one colour (from their name), so a duet or a group's parts can be followed at a glance. */
function singerHue(name: string) {
  let hash = 0
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) | 0
  return Math.abs(hash) % 360
}

/** The singer, named where their part starts: on the line whose singer differs from the previous sung line's. */
export function singerChange(lines: LyricLine[], index: number) {
  const singer = lines[index]?.singer
  if (!singer || !lines[index]!.text) return undefined
  for (let i = index - 1; i >= 0; i--) if (lines[i]!.text) return lines[i]!.singer === singer ? undefined : singer
  return singer
}

/** A small name tag above a line (instead of the lyrics' "{Jennie}"), with the singer's colour dot. */
export function SingerLabel({ name }: { name: string }) {
  return (
    <span className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-white/70">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: `hsl(${singerHue(name)} 85% 65%)` }} />
      {name}
    </span>
  )
}
