import { IconDisc, IconMicrophone2 } from '@tabler/icons-react'
import { cn } from '@/lib/utils'

/** Stands in for a missing picture: a microphone for an artist, a record for an album or song (not scanned yet). */
export function MissingCover({ type, className, iconClassName = 'size-1/2', stroke = 1.5 }: { type?: string | null; className?: string; iconClassName?: string; stroke?: number }) {
  const Icon = type === 'MusicArtist' ? IconMicrophone2 : IconDisc
  return (
    <span className={cn('grid size-full place-items-center bg-muted text-muted-foreground', className)}>
      <Icon className={iconClassName} stroke={stroke} />
    </span>
  )
}
