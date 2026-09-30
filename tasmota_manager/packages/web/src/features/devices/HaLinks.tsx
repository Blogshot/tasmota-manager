import type { Device } from '@tm/shared';
import type { MouseEvent } from 'react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useT } from '@/lib/i18n';

const chipClass = 'inline-flex max-w-48 truncate rounded-md border px-1.5 py-0.5 text-xs hover:bg-accent';
const stop = (e: MouseEvent) => e.stopPropagation();

const MAX_ENTITIES = 3;

/** HA kann die Entitätenliste nicht per URL durchsuchen; alle Entitäten führen deshalb auf die Geräteseite. */
export function HaEntityLinks({ device }: { device: Device }) {
  const t = useT();
  const entities = device.ha?.entities ?? [];
  if (!device.ha || entities.length === 0) return <span className="text-muted-foreground">—</span>;
  const href = `/config/devices/device/${encodeURIComponent(device.ha.deviceId)}`;
  const rest = entities.slice(MAX_ENTITIES);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {entities.slice(0, MAX_ENTITIES).map((e) => (
        <a key={e.entityId} href={href} target="_top" title={e.entityId} className={chipClass} onClick={stop}>
          {e.name}
        </a>
      ))}
      {rest.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={chipClass}
              title={t('devices.entities.more', { count: rest.length })}
              aria-label={t('devices.entities.more', { count: rest.length })}
              onClick={stop}
            >
              …
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" onClick={stop}>
            {rest.map((e) => (
              <DropdownMenuItem key={e.entityId} asChild>
                <a href={href} target="_top" title={e.entityId}>
                  {e.name}
                </a>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

export function HaAutomationLinks({ device }: { device: Device }) {
  const automations = device.ha?.automations ?? [];
  if (automations.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {automations.map((a) =>
        a.id ? (
          <a
            key={a.entityId}
            href={`/config/automation/edit/${encodeURIComponent(a.id)}`}
            target="_top"
            title={a.entityId}
            className={chipClass}
            onClick={stop}
          >
            {a.name}
          </a>
        ) : (
          <span key={a.entityId} title={a.entityId} className={`${chipClass} text-muted-foreground`}>
            {a.name}
          </span>
        ),
      )}
    </div>
  );
}
