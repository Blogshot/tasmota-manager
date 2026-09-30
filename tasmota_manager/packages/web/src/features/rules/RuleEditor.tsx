import { MAX_RULE_LENGTH } from '@tm/shared';
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n';

const TOKEN = /(\b(?:on|do|endon|break|if|else|elseif|endif|and|or)\b)|(%[^%\s]+%)|(\b(?:var|mem)\d+\b)/gi;

/** Einfache Syntax-Hervorhebung für Tasmota-Rules. */
export function highlightRule(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text.slice(last, index));
    const [token, keyword, variable] = match;
    const kind = keyword ? 'keyword' : variable ? 'variable' : 'memory';
    const className =
      kind === 'keyword'
        ? 'font-semibold text-sky-600 dark:text-sky-400'
        : kind === 'variable'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-emerald-600 dark:text-emerald-400';
    nodes.push(
      <span key={key++} data-token={kind} className={className}>
        {token}
      </span>,
    );
    last = index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  max?: number;
}

/** Textarea über einer hervorgehobenen Kopie desselben Texts (gleiche Schrift und Abstände). */
export function RuleEditor({ id, value, onChange, max = MAX_RULE_LENGTH }: Props) {
  const t = useT();
  const tooLong = value.length > max;
  return (
    <div className="space-y-1">
      <div className="relative font-mono text-sm">
        <pre aria-hidden className="pointer-events-none min-h-24 rounded-md border border-transparent px-3 py-2 break-words whitespace-pre-wrap">
          {highlightRule(value)}
          {'\n'}
        </pre>
        <textarea
          id={id}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 h-full w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-transparent caret-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <p className={`text-xs ${tooLong ? 'text-destructive' : 'text-muted-foreground'}`}>
        {t('rules.length', { length: value.length, max })}
        {tooLong ? ` – ${t('rules.tooLong')}` : ''}
      </p>
    </div>
  );
}
