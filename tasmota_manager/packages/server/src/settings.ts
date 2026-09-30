import type { LanguageSetting, Settings, SettingsUpdateRequest } from '@tm/shared';
import type { Db } from './db';
import { settings as settingsTable } from './db/schema';

export interface StoredSettings {
  scanCidrs: string[];
  pollIntervalSec: number;
  concurrency: { command: number; ota: number; backup: number };
  backupRetention: number;
  firmwarePort: number;
  globalPassword: string | null;
  language: LanguageSetting;
}

export function defaultSettings(scanCidrs: string[]): StoredSettings {
  return {
    scanCidrs,
    pollIntervalSec: 60,
    concurrency: { command: 10, ota: 3, backup: 5 },
    backupRetention: 10,
    firmwarePort: 8266,
    globalPassword: null,
    language: 'auto',
  };
}

export class SettingsStore {
  private cache: StoredSettings;

  constructor(
    private readonly db: Db,
    private readonly defaults: StoredSettings,
  ) {
    this.cache = this.load();
  }

  get(): StoredSettings {
    return this.cache;
  }

  update(patch: SettingsUpdateRequest): StoredSettings {
    const normalized: Record<string, unknown> = { ...patch };
    if (normalized.globalPassword === '') normalized.globalPassword = null;
    const entries = Object.entries(normalized).filter(([, value]) => value !== undefined);
    this.db.transaction((tx) => {
      for (const [key, value] of entries) {
        tx.insert(settingsTable)
          .values({ key, valueJson: value })
          .onConflictDoUpdate({ target: settingsTable.key, set: { valueJson: value } })
          .run();
      }
    });
    this.cache = this.load();
    return this.cache;
  }

  toPublic(): Settings {
    const { globalPassword, ...rest } = this.cache;
    return { ...rest, hasGlobalPassword: Boolean(globalPassword) };
  }

  private load(): StoredSettings {
    const rows = this.db.select().from(settingsTable).all();
    const stored = Object.fromEntries(rows.map((row) => [row.key, row.valueJson]));
    return { ...this.defaults, ...stored } as StoredSettings;
  }
}
