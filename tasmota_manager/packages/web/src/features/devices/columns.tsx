import type { ColumnDef } from '@tanstack/react-table';
import type { Device } from '@tm/shared';
import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { useT } from '@/lib/i18n';
import { formatUptime } from './format';
import { HaAutomationLinks, HaEntityLinks } from './HaLinks';
import { NameCell } from './NameCell';
import { StatusDot } from './StatusDot';

const dash = (v: string | number | null) => (v == null || v === '' ? '—' : v);

export function useDeviceColumns(): ColumnDef<Device>[] {
  const t = useT();
  return useMemo<ColumnDef<Device>[]>(
    () => [
      {
        id: 'select',
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllRowsSelected() || (table.getIsSomeRowsSelected() && 'indeterminate')}
            onCheckedChange={(v) => table.toggleAllRowsSelected(Boolean(v))}
            aria-label={t('devices.selectAll')}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(Boolean(v))}
            onClick={(e) => e.stopPropagation()}
            aria-label={t('devices.selectRow')}
          />
        ),
        enableSorting: false,
        enableHiding: false,
      },
      { accessorKey: 'online', header: t('devices.col.status'), sortingFn: 'basic', cell: ({ row }) => <StatusDot device={row.original} /> },
      { accessorKey: 'name', header: t('devices.col.name'), cell: ({ row }) => <NameCell device={row.original} /> },
      {
        accessorKey: 'ip',
        header: t('devices.col.ip'),
        cell: ({ row }) =>
          row.original.ip ? (
            <a
              href={`http://${row.original.ip}`}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {row.original.ip}
            </a>
          ) : (
            '—'
          ),
      },
      { accessorKey: 'firmware', header: t('devices.col.firmware'), cell: ({ row }) => dash(row.original.firmware) },
      { accessorKey: 'module', header: t('devices.col.module'), cell: ({ row }) => dash(row.original.module) },
      {
        accessorKey: 'rssi',
        header: t('devices.col.rssi'),
        cell: ({ row }) => (row.original.rssi == null ? '—' : `${row.original.rssi} dBm`),
      },
      {
        id: 'channels',
        header: t('devices.col.channels'),
        accessorFn: (d) => d.channels.join(','),
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.original.channels.map((c) => (
              <Badge key={c} variant="outline">
                {c.toUpperCase()}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: 'tags',
        header: t('devices.col.tags'),
        accessorFn: (d) => d.tags.join(','),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.tags.map((tag) => (
              <Badge key={tag} variant="secondary">
                {tag}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: 'entities',
        header: t('devices.col.entities'),
        accessorFn: (d) => d.ha?.entities.length ?? 0,
        cell: ({ row }) => <HaEntityLinks device={row.original} />,
      },
      {
        id: 'automations',
        header: t('devices.col.automations'),
        accessorFn: (d) => d.ha?.automations.length ?? 0,
        cell: ({ row }) => <HaAutomationLinks device={row.original} />,
      },
      { accessorKey: 'uptimeSec', header: t('devices.col.uptime'), cell: ({ row }) => formatUptime(row.original.uptimeSec) },
    ],
    [t],
  );
}
