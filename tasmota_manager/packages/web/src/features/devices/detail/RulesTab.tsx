import { useQuery } from '@tanstack/react-query';
import { MAX_RULE_LENGTH, type RuleState } from '@tm/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useStage } from '@/features/changes/useStage';
import { RuleEditor } from '@/features/rules/RuleEditor';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';

export function RulesTab({ deviceId }: { deviceId: string }) {
  const t = useT();
  const { data, error } = useQuery({ queryKey: ['rules', deviceId], queryFn: () => api.rules(deviceId) });
  if (error) return <p className="text-sm text-destructive">{t('rules.loadError', { message: error.message })}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">…</p>;
  return (
    <div className="space-y-6">
      <p className="text-xs text-muted-foreground">{t('detail.pendingHint')}</p>
      {data.map((rule) => (
        <RuleSlot key={rule.index} deviceId={deviceId} rule={rule} />
      ))}
    </div>
  );
}

function RuleSlot({ deviceId, rule }: { deviceId: string; rule: RuleState }) {
  const t = useT();
  const [text, setText] = useState(rule.text);
  const [enabled, setEnabled] = useState(rule.enabled);
  const stage = useStage();
  const max = Math.min(rule.length + rule.free, MAX_RULE_LENGTH);
  const changed = text !== rule.text || enabled !== rule.enabled;
  const title = t('rules.rule', { n: rule.index });
  const editorId = `detail-rule-${rule.index}`;
  const submit = () => {
    const settings: Record<string, string> = {};
    if (text !== rule.text) settings[`Rule${rule.index}`] = text;
    if (enabled !== rule.enabled) settings[`Rule${rule.index}Enabled`] = enabled ? '1' : '0';
    stage.mutate({ deviceIds: [deviceId], settings, source: 'rule' });
  };
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-3">
        <label htmlFor={editorId} className="font-medium">
          {title}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(Boolean(v))} aria-label={`${title} ${t('rules.enabled')}`} />
          {t('rules.enabled')}
        </label>
        <Button size="sm" className="ml-auto" disabled={!changed || text.length > max || stage.isPending} onClick={submit}>
          {t('edit.stage')}
        </Button>
      </div>
      <RuleEditor id={editorId} value={text} onChange={setText} max={max} />
    </section>
  );
}
