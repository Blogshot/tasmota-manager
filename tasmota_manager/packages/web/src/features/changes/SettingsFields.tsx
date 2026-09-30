import type { SettingDef } from '@tm/shared';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { validationText } from '@/lib/errors';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/messages';
import { selectClass } from '@/lib/styles';

export type FieldValues = Record<string, string>;

interface Props {
  defs: readonly SettingDef[];
  values: FieldValues;
  errors: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Aktuelle Werte eines Geräts (Detailansicht); erscheinen als Platzhalter. */
  current?: Record<string, string | null>;
  idPrefix: string;
}

const POWER_ON_STATES = ['0', '1', '2', '3', '4', '5'] as const;

/** Leere Felder bedeuten „unverändert“. */
export function SettingsFields({ defs, values, errors, onChange, current, idPrefix }: Props) {
  const t = useT();
  const groups = [...new Set(defs.map((d) => d.group))];
  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <fieldset key={group} className="space-y-3">
          <legend className="text-sm font-medium">{t(`group.${group}` as MessageKey)}</legend>
          {defs
            .filter((d) => d.group === group)
            .map((def) => {
              const id = `${idPrefix}-${def.key}`;
              const value = values[def.key] ?? '';
              const currentValue = current?.[def.key] ?? null;
              const unchanged = currentValue !== null ? `${t('edit.unchanged')} (${currentValue})` : t('edit.unchanged');
              const isSelect = def.kind === 'bool' || def.key === 'PowerOnState';
              return (
                <div key={def.key} className="space-y-1">
                  <Label htmlFor={id}>{t(`setting.${def.key}` as MessageKey)}</Label>
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
                  {errors[def.key] && <p className="text-xs text-destructive">{validationText(t, errors[def.key] ?? '')}</p>}
                </div>
              );
            })}
        </fieldset>
      ))}
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
