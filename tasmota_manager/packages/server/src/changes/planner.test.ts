import { describe, expect, it } from 'vitest';
import { isRestartCommand, planDevice } from './planner';
import type { PendingRow } from './store';

let nextId = 1;
const setting = (key: string, value: string): PendingRow => ({
  id: nextId++,
  deviceId: 'A',
  kind: 'setting',
  key,
  value,
  position: 0,
  source: 'form',
  error: null,
  updatedAt: 'now',
});
const command = (value: string, position: number): PendingRow => ({ ...setting('', value), kind: 'command', key: null, position });

describe('isRestartCommand', () => {
  it('erkennt Neustart-Befehle nur mit Argument', () => {
    expect(isRestartCommand('Restart 1')).toBe(true);
    expect(isRestartCommand('Topic keller')).toBe(true);
    expect(isRestartCommand('MqttHost')).toBe(false);
    expect(isRestartCommand('Template {"NAME":"x"}')).toBe(false);
    expect(isRestartCommand('Power ON')).toBe(false);
  });
});

describe('planDevice', () => {
  it('schreibt Einstellungen in Katalog-Reihenfolge, Befehle danach, Neustart-Einstellungen gebündelt zuletzt', () => {
    const rows = [
      setting('MqttUser', 'u1'),
      command('Power ON', 2),
      setting('TelePeriod', '60'),
      setting('MqttHost', 'neu.local'),
      command('Restart 1', 1),
      setting('PowerOnState', '1'),
      setting('MqttPassword', 'geheim'),
    ];
    const plan = planDevice(rows);
    expect(plan.settings.map((s) => s.command)).toEqual(['PowerOnState 1', 'TelePeriod 60']);
    expect(plan.commands.map((s) => [s.command, s.restarts, s.idempotent])).toEqual([
      ['Restart 1', true, false],
      ['Power ON', false, false],
    ]);
    expect(plan.restartBundle?.command).toBe('Backlog MqttHost neu.local; MqttUser u1; MqttPassword geheim');
    expect(plan.restartBundle?.changeIds).toHaveLength(3);
    expect(plan.verifySettings.map((v) => v.def.key)).toEqual(['PowerOnState', 'TelePeriod']);
    // Das Passwort ist write-only und wird nicht zurückgelesen.
    expect(plan.verifyRestart.map((v) => v.def.key)).toEqual(['MqttHost', 'MqttUser']);
  });

  it('setzt den Rule-Text vor dem Aktivieren', () => {
    const plan = planDevice([setting('Rule1Enabled', '1'), setting('Rule1', 'ON x DO y ENDON')]);
    expect(plan.settings.map((s) => s.command)).toEqual(['Rule1 ON x DO y ENDON', 'Rule1 1']);
  });

  it('liefert einen leeren Plan ohne Einträge', () => {
    expect(planDevice([])).toEqual({ settings: [], verifySettings: [], commands: [], restartBundle: null, verifyRestart: [] });
  });
});
