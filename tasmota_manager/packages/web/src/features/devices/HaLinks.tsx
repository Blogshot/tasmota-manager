import type { Device } from '@tm/shared';
import type { MouseEvent } from 'react';

const chipClass = 'inline-flex max-w-48 truncate rounded-md border px-1.5 py-0.5 text-xs hover:bg-accent';
const stop = (e: MouseEvent) => e.stopPropagation();

export function HaEntityLinks({ device }: { device: Device }) {
  const entities = device.ha?.entities ?? [];
  if (entities.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {entities.map((e) => (
        <a
          key={e.entityId}
          href={`/config/entities?search=${encodeURIComponent(e.entityId)}`}
          target="_top"
          title={e.entityId}
          className={chipClass}
          onClick={stop}
        >
          {e.name}
        </a>
      ))}
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
