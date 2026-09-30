import type { Device, HaLink, Language } from '@tm/shared';
import type { PendingStore } from './changes/store';
import { suggestNames } from './naming';
import type { DeviceRegistry } from './registry';

export interface HaLookup {
  link(mac: string): HaLink | null;
}

/** Ergänzt die Registry-Geräte um HA-Links, Namensvorschläge und Pufferstatus. */
export class DeviceEnricher {
  constructor(
    private readonly registry: DeviceRegistry,
    private readonly store: PendingStore,
    private readonly ha: HaLookup | null,
    /** Sprache der Namensvorschläge */
    private readonly language: () => Language = () => 'en',
  ) {}

  all(): Device[] {
    const devices = this.registry.list();
    const raw = new Map(this.registry.listRaw().map((r) => [r.id, r]));
    const counts = this.store.counts();
    const pendingNames = this.store.pendingNames();
    const links = new Map(devices.map((d) => [d.id, this.ha?.link(d.id) ?? null]));
    const suggestions = suggestNames(
      devices.map((d) => ({
        id: d.id,
        name: pendingNames.get(d.id) ?? d.name,
        hostname: d.hostname,
        module: d.module,
        status: raw.get(d.id)?.statusJson,
        sensors: raw.get(d.id)?.sensorsJson,
        areaName: links.get(d.id)?.areaName ?? null,
      })),
      this.language(),
    );
    return devices.map((d) => {
      const pendingName = pendingNames.get(d.id) ?? null;
      const suggestion = suggestions.get(d.id) ?? null;
      return {
        ...d,
        ha: links.get(d.id) ?? null,
        pendingCount: counts.get(d.id) ?? 0,
        pendingName,
        nameSuggestion: pendingName || suggestion === d.name ? null : suggestion,
      };
    });
  }

  one(id: string): Device | null {
    return this.all().find((d) => d.id === id) ?? null;
  }
}
