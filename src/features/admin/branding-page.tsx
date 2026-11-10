import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react'
import { Fragment, useRef, useState, type ChangeEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Row, Section, SettingsPage, SwitchField } from '@/features/settings/fields'
import { useMessages } from '@/lib/i18n'
import { APP_MODES } from '@/lib/app-mode'
import { cn } from '@/lib/utils'
import { DEFAULT_APP_NAME, DEFAULT_MODE_LABELS, useLumioConfig } from './branding'
import type { LumioConfig, ModeBranding } from './lumio-config'
import { adminMessages } from './messages'
import { readImage, useIsAdmin, useSaveConfig } from './use-admin-config'

const COLOR_SWATCHES = ['#e50914', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899']
const HEX = /^#[0-9a-f]{6}$/i

type BrandingFields = Pick<LumioConfig, 'appName' | 'logo' | 'logoLight' | 'favicon' | 'faviconLight' | 'primaryColor' | 'customCss' | 'modes'>

export function BrandingPage() {
  const t = useMessages(adminMessages)
  const isAdmin = useIsAdmin()
  const config = useLumioConfig().data ?? {}
  const save = useSaveConfig()
  // Edits collect in a draft until saved; the page shows the draft over the stored values.
  const [draft, setDraft] = useState<BrandingFields>({})
  const value = { ...config, ...draft }
  const dirty = Object.keys(draft).length > 0
  const edit = (patch: BrandingFields) => setDraft((current) => ({ ...current, ...patch }))

  if (!isAdmin) {
    return (
      <SettingsPage title={t.brandingTitle}>
        <p className="text-sm text-muted-foreground">{t.adminOnly}</p>
      </SettingsPage>
    )
  }

  return (
    <SettingsPage title={t.brandingTitle} description={t.brandingDescription}>
      <Section title={t.identity}>
        <Row label={t.appName} hint={t.appNameHint} htmlFor="app-name">
          <Input id="app-name" value={value.appName ?? ''} placeholder={DEFAULT_APP_NAME} maxLength={40} onChange={(event) => edit({ appName: event.target.value || undefined })} />
        </Row>
        <ImageRow
          label={t.logo}
          hint={t.logoHint}
          value={value.logo}
          light={value.logoLight}
          maxSize={512}
          onChange={(logo) => edit({ logo })}
          onLightChange={(logoLight) => edit({ logoLight })}
          previewClassName="h-10 w-32"
        />
        <ImageRow
          label={t.favicon}
          hint={t.faviconHint}
          value={value.favicon}
          light={value.faviconLight}
          maxSize={128}
          onChange={(favicon) => edit({ favicon })}
          onLightChange={(faviconLight) => edit({ faviconLight })}
          previewClassName="size-10"
        />
      </Section>

      {/* Each app can carry its own label and logo, e.g. "Nauren Kino" and "Nauren Musik". */}
      <Section title={t.apps} description={t.appsHint}>
        {APP_MODES.map((mode) => {
          const own = value.modes?.[mode] ?? {}
          const editMode = (patch: ModeBranding) => edit({ modes: { ...value.modes, [mode]: { ...own, ...patch } } })
          return (
            <Fragment key={mode}>
              <Row label={t.modeLabel(DEFAULT_MODE_LABELS[mode])} hint={t.modeLabelHint} htmlFor={`mode-label-${mode}`}>
                <Input
                  id={`mode-label-${mode}`}
                  value={own.label ?? ''}
                  placeholder={DEFAULT_MODE_LABELS[mode]}
                  maxLength={30}
                  onChange={(event) => editMode({ label: event.target.value || undefined })}
                />
              </Row>
              <SwitchField
                id={`mode-hide-name-${mode}`}
                label={t.hideName(DEFAULT_MODE_LABELS[mode])}
                hint={t.hideNameHint}
                checked={!!own.hideName}
                onChange={(checked) => editMode({ hideName: checked || undefined })}
              />
              <ImageRow
                label={t.modeLogo(DEFAULT_MODE_LABELS[mode])}
                hint={t.modeLogoHint}
                value={own.logo}
                light={own.logoLight}
                maxSize={512}
                onChange={(logo) => editMode({ logo })}
                onLightChange={(logoLight) => editMode({ logoLight })}
                previewClassName="h-10 w-32"
              />
              {mode === 'listen' && (
                <ImageRow
                  label={t.platformAvatar}
                  hint={t.platformAvatarHint}
                  value={own.avatar}
                  light={own.avatarLight}
                  maxSize={512}
                  onChange={(avatar) => editMode({ avatar })}
                  onLightChange={(avatarLight) => editMode({ avatarLight })}
                  previewClassName="size-10 rounded-full"
                />
              )}
            </Fragment>
          )
        })}
      </Section>

      <Section title={t.colors}>
        <Row label={t.primaryColor} hint={t.primaryColorHint} htmlFor="primary-color">
          <ColorPicker id="primary-color" value={value.primaryColor} onChange={(primaryColor) => edit({ primaryColor })} />
        </Row>
        {/* Each app can have its own: a calm one for films, a lively one for music. */}
        {APP_MODES.map((mode) => {
          const own = value.modes?.[mode] ?? {}
          return (
            <Row key={mode} label={t.modeColor(DEFAULT_MODE_LABELS[mode])} hint={t.modeColorHint(mode)} htmlFor={`primary-color-${mode}`}>
              <ColorPicker
                id={`primary-color-${mode}`}
                value={own.primaryColor}
                onChange={(primaryColor) => edit({ modes: { ...value.modes, [mode]: { ...own, primaryColor } } })}
              />
            </Row>
          )
        })}
      </Section>

      <Section title={t.customCss}>
        <div className="space-y-2 p-4">
          <p className="text-sm text-muted-foreground">{t.customCssHint}</p>
          <textarea
            aria-label={t.customCss}
            value={value.customCss ?? ''}
            onChange={(event) => edit({ customCss: event.target.value || undefined })}
            spellCheck={false}
            rows={10}
            placeholder={'.hero h1 {\n  letter-spacing: -0.02em;\n}'}
            className="w-full rounded-lg border border-input bg-background/60 p-3 font-mono text-xs outline-none focus-visible:border-foreground/35 focus-visible:bg-background"
          />
        </div>
      </Section>

      <p className="text-xs text-muted-foreground">{t.storageNote}</p>

      {/* Sticky save bar while there are changes. */}
      {dirty && (
        <div className="sticky bottom-[calc(var(--bottom-inset,0px)+1rem)] z-30 flex items-center justify-between gap-3 rounded-xl bg-popover/95 ring-1 ring-foreground/10 p-3 shadow-xl backdrop-blur animate-in fade-in-0 slide-in-from-bottom-2">
          <span className="text-sm text-muted-foreground">{t.unsaved}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setDraft({})} disabled={save.isPending}>
              {t.discard}
            </Button>
            <Button
              disabled={save.isPending || [value.primaryColor, value.modes?.watch?.primaryColor, value.modes?.listen?.primaryColor].some((color) => !!color && !HEX.test(color))}
              onClick={() => save.mutate((current) => ({ ...current, ...draft }), { onSuccess: () => setDraft({}) })}
            >
              {save.isPending ? t.saving : t.save}
            </Button>
          </div>
        </div>
      )}
    </SettingsPage>
  )
}

/** Swatches, "default", and a field for any #rrggbb. */
function ColorPicker({ id, value, onChange }: { id: string; value: string | undefined; onChange: (value: string | undefined) => void }) {
  const t = useMessages(adminMessages)
  const text = value ?? ''
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t.primaryColor}>
        <button
          type="button"
          aria-pressed={!value}
          onClick={() => onChange(undefined)}
          className={cn('h-8 rounded-full border px-3 text-xs transition-colors hover:bg-muted', !value && 'ring-2 ring-ring')}
        >
          {t.defaultColor}
        </button>
        {COLOR_SWATCHES.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            aria-pressed={value?.toLowerCase() === color}
            onClick={() => onChange(color)}
            className={cn('size-8 rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110', value?.toLowerCase() === color && 'ring-2 ring-foreground')}
            style={{ background: color }}
          />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className="size-8 shrink-0 rounded-md border" style={{ background: HEX.test(text) ? text : 'transparent' }} aria-hidden />
        <Input
          id={id}
          value={text}
          placeholder="#3b82f6"
          maxLength={7}
          className="w-32 font-mono"
          onChange={(event) => onChange(event.target.value.trim() || undefined)}
          aria-invalid={!!text && !HEX.test(text)}
        />
      </div>
    </div>
  )
}

interface ImageRowProps {
  label: string
  hint: string
  /** The picture for dark (and for light too while there is no light one). */
  value?: string
  /** The picture for light, if one was uploaded. */
  light?: string
  maxSize: number
  onChange: (value: string | undefined) => void
  onLightChange: (value: string | undefined) => void
  previewClassName: string
}

/**
 * A picture the admin uploads: one serves both looks; with "separate for light" a second one replaces it there. Each
 * preview sits on its look's background, so a dark logo on a dark page shows up as the problem it is.
 */
function ImageRow({ label, hint, value, light, maxSize, onChange, onLightChange, previewClassName }: ImageRowProps) {
  const t = useMessages(adminMessages)
  const [split, setSplit] = useState(!!light)
  const separate = split || !!light
  return (
    <Row label={label} hint={hint}>
      <div className="space-y-2">
        <ImagePicker
          caption={separate ? t.imageDark : undefined}
          value={value}
          maxSize={maxSize}
          onChange={onChange}
          previewClassName={cn(previewClassName, separate && 'bg-neutral-950')}
        />
        {separate && (
          <ImagePicker
            caption={t.imageLight}
            value={light}
            maxSize={maxSize}
            onChange={(next) => {
              onLightChange(next)
              if (!next) setSplit(false)
            }}
            previewClassName={cn(previewClassName, 'bg-white')}
          />
        )}
        {!separate && value && (
          <div className="flex sm:justify-end">
            <button type="button" onClick={() => setSplit(true)} className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              {t.imageSeparateLight}
            </button>
          </div>
        )}
      </div>
    </Row>
  )
}

function ImagePicker({
  caption,
  value,
  maxSize,
  onChange,
  previewClassName,
}: {
  caption?: string
  value?: string
  maxSize: number
  onChange: (value: string | undefined) => void
  previewClassName: string
}) {
  const t = useMessages(adminMessages)
  const input = useRef<HTMLInputElement>(null)

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      onChange(await readImage(file, maxSize))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t.imageUnreadable)
    }
  }

  return (
    <div className="flex items-center gap-3 sm:justify-end">
      {caption && <span className="mr-auto text-xs text-muted-foreground sm:mr-0">{caption}</span>}
      <div className={cn('grid shrink-0 place-items-center overflow-hidden rounded-md bg-muted', previewClassName)}>
        {value ? <img src={value} alt="" className="max-h-full max-w-full object-contain" /> : <IconPhoto className="size-4 text-muted-foreground" />}
      </div>
      {/* The native file picker opens from our own button; the input itself stays hidden. */}
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={(event) => void onFile(event)} />
      <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
        <IconUpload /> {value ? t.replace : t.upload}
      </Button>
      {value && (
        <Button variant="ghost" size="icon-sm" aria-label={t.remove} title={t.remove} onClick={() => onChange(undefined)}>
          <IconX />
        </Button>
      )}
    </div>
  )
}
