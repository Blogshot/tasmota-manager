import { useMutation } from '@tanstack/react-query';
import type { CommandResult } from '@tm/shared';
import { type FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { errorText } from '@/lib/errors';
import { useT } from '@/lib/i18n';

interface Entry {
  id: number;
  command: string;
  result: CommandResult;
}

let nextId = 0;

export function Console({ deviceId }: { deviceId: string }) {
  const t = useT();
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<Entry[]>([]);
  const push = (command: string, result: CommandResult) =>
    setHistory((h) => [...h, { id: nextId++, command, result }].slice(-50));
  const mutation = useMutation({
    mutationFn: (command: string) => api.command(deviceId, command),
    onSuccess: (result, command) => push(command, result),
    onError: (err, command) => push(command, { ok: false, code: 'unreachable', message: err.message }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const command = input.trim();
    if (!command) return;
    mutation.mutate(command);
    setInput('');
  };

  return (
    <div className="space-y-2">
      <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border bg-muted/30 p-2 font-mono text-xs">
        {history.map((entry) => (
          <div key={entry.id}>
            <div className="flex gap-2 font-semibold">
              <span>{entry.command}</span>
              {entry.result.ok && <span className="text-muted-foreground">{t('console.via', { channel: entry.result.channel.toUpperCase() })}</span>}
            </div>
            <pre className={`whitespace-pre-wrap ${entry.result.ok ? '' : 'text-destructive'}`}>
              {entry.result.ok ? JSON.stringify(entry.result.response, null, 2) : `${entry.result.code}: ${errorText(t, entry.result)}`}
            </pre>
          </div>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={submit}>
        <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder={t('console.placeholder')} className="font-mono" />
        <Button type="submit" disabled={mutation.isPending}>
          {t('console.send')}
        </Button>
      </form>
    </div>
  );
}
