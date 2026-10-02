import { type Device, type SettingDef, settingApplies } from '@tm/shared';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { HaFieldSuggestions } from '@/features/changes/HaFieldSuggestions';
import { LocationTools } from '@/features/location/LocationTools';
import { validationText } from '@/lib/errors';
import { type Translate, useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/messages';
import { selectClass } from '@/lib/styles';

export type FieldValues = Record<string, string>;

interface Props {
  defs: readonly SettingDef[];
  /** Betroffene Geräte; bestimmt sichtbare Felder und „gilt für X von Y“. */
  devices: Device[];
  /** Wird angeboten, wenn TelePeriod unter 10 s eingegeben wird. */
  onFastRule?: () => void;
  values: FieldValues;
  errors: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Aktuelle Werte eines Geräts (Detailansicht); erscheinen statt „unverändert“ im leeren Feld. */
  current?: Record<string, string | null>;
  /** Felder, deren aktueller Wert gerade vom Gerät gelesen wird. */
  loading?: ReadonlySet<string>;
  idPrefix: string;
}

const POWER_ON_STATES = ['0', '1', '2', '3', '4', '5'] as const;

/** Leere Felder bedeuten „unverändert“. */
export function SettingsFields({ defs, devices, values, errors, onChange, onFastRule, current, loading, idPrefix }: Props) {
  const t = useT();
  const applying = (def: SettingDef) => devices.filter((d) => settingApplies(def, d.capabilities)).length;
  const visible = defs.filter((d) => applying(d) > 0);
  const visibleKeys = new Set(visible.map((d) => d.key));
  const groups = [...new Set(visible.map((d) => d.group))];
  const unknownType = devices.filter((d) => d.capabilities.length === 0).length;
  const hasEnergy = devices.some((d) => d.capabilities.includes('energy'));
  return (
    <div className="space-y-5">
      {devices.length > 1 && unknownType > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('edit.unknownType', { count: unknownType })}</p>
      )}
      {devices.length === 1 && unknownType === 1 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('edit.unknownTypeSingle')}</p>
      )}
      {groups.map((group) => (
        <fieldset key={group} className="space-y-3">
          <legend className="text-sm font-medium">{t(`group.${group}` as MessageKey)}</legend>
          {group === 'location' && (
            <LocationTools
              latitude={values.Latitude ?? ''}
              longitude={values.Longitude ?? ''}
              onPick={(latitude, longitude) => {
                onChange('Latitude', latitude);
                onChange('Longitude', longitude);
              }}
            />
          )}
          {visible
            .filter((d) => d.group === group)
            .map((def) => {
              const id = `${idPrefix}-${def.key}`;
              const value = values[def.key] ?? '';
              const currentValue = current?.[def.key] ?? null;
              const isLoading = loading?.has(def.key) ?? false;
              const isSelect = def.kind === 'bool' || def.key === 'PowerOnState';
              // Leeres Feld = nicht ändern; angezeigt wird der aktuelle Wert des Geräts, sofern bekannt.
              const placeholder = isLoading ? '' : (currentValue ?? t('edit.unchanged'));
              const emptyOption = isLoading
                ? ''
                : currentValue !== null
                  ? `${optionLabel(def, currentValue, t)} (${t('edit.current')})`
                  : t('edit.unchanged');
              return (
                <div key={def.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor={id}>{t(`setting.${def.key}` as MessageKey)}</Label>
                    {devices.length > 1 && def.appliesTo.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {t('edit.appliesTo', { count: applying(def), total: devices.length })}
                      </span>
                    )}
                  </div>
                  <div className="relative">
                  {isSelect ? (
                    <select id={id} className={`${selectClass} w-full`} value={value} onChange={(e) => onChange(def.key, e.target.value)}>
                      <option value="">{emptyOption}</option>
                      {def.kind === 'bool' ? (
                        <>
                          <option value="1">{t('bool.on')}</option>
                          <option value="0">{t('bool.off')}</option>
                        </>
                      ) : (
                        POWER_ON_STATES.map((v) => (
                          <option key={v} value={v}>
                            {t(`powerOn.${v}` as MessageKey)}
                          </option>
                        ))
                      )}
                    </select>
                  ) : (
                    <Input
                      id={id}
                      type={def.writeOnly ? 'password' : 'text'}
                      autoComplete={def.writeOnly ? 'new-password' : 'off'}
                      value={value}
                      placeholder={placeholder}
                      onChange={(e) => onChange(def.key, e.target.value)}
                    />
                  )}
                  {isLoading && value === '' && (
                    <Loader2
                      role="status"
                      aria-label={t('common.loading')}
                      className={`pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground left-3`}
                    />
                  )}
                  </div>
                  <HaFieldSuggestions
                    fieldKey={def.key}
                    visibleKeys={visibleKeys}
                    onFill={(filled) => {
                      for (const [k, v] of Object.entries(filled)) onChange(k, v);
                    }}
                  />
                  {def.hint && (
                    <p className={`text-xs ${def.key === 'Interlock' ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`}>
                      {t(`hint.${def.key}` as MessageKey)}
                    </p>
                  )}
                  {def.key === 'TelePeriod' && <TelePeriodNotes value={value} energy={hasEnergy} onFastRule={onFastRule} />}
                  {errors[def.key] && <p className="text-xs text-destructive">{validationText(t, errors[def.key] ?? '')}</p>}
                </div>
              );
            })}
        </fieldset>
      ))}
    </div>
  );
}

/** Anzeigetext eines aktuellen Werts in Auswahlfeldern (Ein/Aus, PowerOnState). */
function optionLabel(def: SettingDef, value: string, t: Translate): string {
  if (def.kind === 'bool') {
    const on = ['1', 'ON', 'TRUE'].includes(value.trim().toUpperCase());
    const off = ['0', 'OFF', 'FALSE'].includes(value.trim().toUpperCase());
    return on ? t('bool.on') : off ? t('bool.off') : value;
  }
  if (def.key === 'PowerOnState' && /^[0-5]$/.test(value.trim())) return t(`powerOn.${value.trim()}` as MessageKey);
  return value;
}

function TelePeriodNotes({ value, energy, onFastRule }: { value: string; energy: boolean; onFastRule?: () => void }) {
  const t = useT();
  const seconds = Number(value);
  if (value.trim() === '' || !Number.isFinite(seconds) || seconds >= 60) return null;
  return (
    <div className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
      <p>{t('telePeriod.dbWarning')}</p>
      {energy && <p>{t('telePeriod.powerDelta')}</p>}
      {seconds < 10 && (
        <p className="flex flex-wrap items-center gap-2">
          {t('telePeriod.tooShort')}
          {onFastRule && (
            <Button type="button" size="sm" variant="outline" onClick={onFastRule}>
              {t('telePeriod.offerRule')}
            </Button>
          )}
        </p>
      )}
    </div>
  );
}

/** Validiert die ausgefüllten Felder mit dem Katalog-Schema. */
export function collectSettings(
  defs: readonly SettingDef[],
  values: FieldValues,
): { settings: Record<string, string>; errors: Record<string, string> } {
  const settings: Record<string, string> = {};
  const errors: Record<string, string> = {};
  for (const def of defs) {
    const raw = values[def.key];
    if (raw === undefined || raw.trim() === '') continue;
    // Deutsche Eingabe mit Dezimalkomma; das Schema verlangt den Punkt.
    const input = def.kind === 'decimal' || def.kind === 'coord' ? raw.replace(',', '.') : raw;
    const parsed = def.schema.safeParse(input);
    if (parsed.success) settings[def.key] = parsed.data;
    else errors[def.key] = parsed.error.issues[0]?.message ?? 'invalid.invalid';
  }
  return { settings, errors };
}
