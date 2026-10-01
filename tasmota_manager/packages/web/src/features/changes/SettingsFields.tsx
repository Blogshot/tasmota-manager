import { type Device, type SettingDef, settingApplies } from '@tm/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LocationTools } from '@/features/location/LocationTools';
import { validationText } from '@/lib/errors';
import { useT } from '@/lib/i18n';
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
  /** Aktuelle Werte eines Geräts (Detailansicht); erscheinen als Platzhalter. */
  current?: Record<string, string | null>;
  idPrefix: string;
}

const POWER_ON_STATES = ['0', '1', '2', '3', '4', '5'] as const;

/** Leere Felder bedeuten „unverändert“. */
export function SettingsFields({ defs, devices, values, errors, onChange, onFastRule, current, idPrefix }: Props) {
  const t = useT();
  const applying = (def: SettingDef) => devices.filter((d) => settingApplies(def, d.capabilities)).length;
  const visible = defs.filter((d) => applying(d) > 0);
  const groups = [...new Set(visible.map((d) => d.group))];
  const unknownType = devices.filter((d) => d.capabilities.length === 0).length;
  const hasEnergy = devices.some((d) => d.capabilities.includes('energy'));
  return (
    <div className="space-y-5">
      {devices.length > 1 && unknownType > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('edit.unknownType', { count: unknownType })}</p>
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
              const unchanged = currentValue !== null ? `${t('edit.unchanged')} (${currentValue})` : t('edit.unchanged');
              const isSelect = def.kind === 'bool' || def.key === 'PowerOnState';
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
                  {isSelect ? (
                    <select id={id} className={`${selectClass} w-full`} value={value} onChange={(e) => onChange(def.key, e.target.value)}>
                      <option value="">{unchanged}</option>
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
                      placeholder={unchanged}
                      onChange={(e) => onChange(def.key, e.target.value)}
                    />
                  )}
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
    const parsed = def.schema.safeParse(raw);
    if (parsed.success) settings[def.key] = parsed.data;
    else errors[def.key] = parsed.error.issues[0]?.message ?? 'invalid.invalid';
  }
  return { settings, errors };
}
