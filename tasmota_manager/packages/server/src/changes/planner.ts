import { type SettingDef, commandFor, settingDef } from '@tm/shared';
import { isQuery, splitCommand } from '../tasmota/commands';
import type { PendingRow } from './store';

export interface SendStep {
  command: string;
  changeIds: number[];
  /** Nach dem Befehl auf den Neustart warten. */
  restarts: boolean;
  /** Darf nach einem Timeout wiederholt werden. */
  idempotent: boolean;
  /** Freier Befehl ohne Verify: gilt mit dem erfolgreichen Senden als erledigt. */
  settleOnSend: boolean;
}

export interface VerifyItem {
  changeId: number;
  def: SettingDef;
  expected: string;
}

export interface DevicePlan {
  /** Einstellungen ohne Neustart inkl. Rules und Timer, in Katalog-Reihenfolge. */
  settings: SendStep[];
  verifySettings: VerifyItem[];
  commands: SendStep[];
  /** Alle Einstellungen mit Neustart als ein einziger Backlog. */
  restartBundle: SendStep | null;
  verifyRestart: VerifyItem[];
}

// Befehle, nach denen Tasmota zuverlässig neu startet. Template (nur mit Module 0) und Upgrade (OTA, kann > 90 s dauern) fehlen bewusst.
const RESTART_COMMANDS = new Set([
  'RESTART',
  'MODULE',
  'TOPIC',
  'FULLTOPIC',
  'GROUPTOPIC',
  'HOSTNAME',
  'WIFICONFIG',
  'SSID1',
  'SSID2',
  'PASSWORD1',
  'PASSWORD2',
  'IPADDRESS1',
  'IPADDRESS2',
  'IPADDRESS3',
  'IPADDRESS4',
  'MQTTHOST',
  'MQTTPORT',
  'MQTTUSER',
  'MQTTPASSWORD',
  'MQTTCLIENT',
  'RESET',
]);

export function isRestartCommand(command: string): boolean {
  const { name, args } = splitCommand(command);
  return args !== '' && RESTART_COMMANDS.has(name.toUpperCase());
}

interface SettingRow {
  row: PendingRow;
  def: SettingDef;
}

const toVerify = (list: SettingRow[]): VerifyItem[] =>
  list.filter((s) => !s.def.writeOnly).map((s) => ({ changeId: s.row.id, def: s.def, expected: s.row.value }));

export function planDevice(rows: readonly PendingRow[]): DevicePlan {
  const settings: SettingRow[] = rows
    .filter((r) => r.kind === 'setting' && r.key)
    .flatMap((row) => {
      const def = settingDef(row.key ?? '');
      return def ? [{ row, def }] : [];
    })
    .sort((a, b) => a.def.order - b.def.order);
  const plain = settings.filter((s) => !s.def.restarts);
  const restarting = settings.filter((s) => s.def.restarts);

  return {
    settings: plain.map((s) => ({ command: commandFor(s.def, s.row.value), changeIds: [s.row.id], restarts: false, idempotent: true, settleOnSend: false })),
    verifySettings: toVerify(plain),
    commands: rows
      .filter((r) => r.kind === 'command')
      .sort((a, b) => a.position - b.position || a.id - b.id)
      .map((r) => ({
        command: r.value,
        changeIds: [r.id],
        restarts: isRestartCommand(r.value),
        idempotent: isQuery(r.value),
        settleOnSend: true,
      })),
    restartBundle:
      restarting.length === 0
        ? null
        : {
            command: `Backlog ${restarting.map((s) => commandFor(s.def, s.row.value)).join('; ')}`,
            changeIds: restarting.map((s) => s.row.id),
            restarts: true,
            idempotent: true,
            settleOnSend: false,
          },
    verifyRestart: toVerify(restarting),
  };
}
