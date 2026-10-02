import { settingDef, type Device, type HaLink, type Language } from '@tm/shared';
import type { PendingStore } from './changes/store';
import { capabilitiesOf } from './capabilities';
import { suggestNames } from './naming';
import type { DeviceRegistry } from './registry';

export interface HaLookup {
  link(mac: string): HaLink | null;
  /** Verbunden und Registry mindestens einmal geladen; erst dann ist „nicht in HA“ aussagekräftig. */
  readonly ready?: boolean;
  readonly linksLoaded?: boolean;
}

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Ergänzt die Registry-Geräte um HA-Links, Namensvorschläge und Pufferstatus. */
export class DeviceEnricher {
  constructor(
    private readonly registry: DeviceRegistry,
    private readonly store: PendingStore,
    private readonly ha: HaLookup | null,
    /** Sprache der Namensvorschläge */
    private readonly language: () => Language = () => 'en',
    private readonly now: () => Date = () => new Date(),
  ) {}

  all(): Device[] {
    const devices = this.registry.list();
    const raw = new Map(this.registry.listRaw().map((r) => [r.id, r]));
    const counts = this.store.counts();
    const pendingNames = this.store.pendingNames();
    const links = new Map(devices.map((d) => [d.id, this.ha?.link(d.id) ?? null]));
    const suggestions = suggestNames(
      // Abgelehnte Vorschläge fallen ganz heraus, damit sie auch keinen Namen für andere Geräte belegen.
      devices.filter((d) => !d.suggestionDismissed).map((d) => ({
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
      const linked = d.suggestionDismissed ? null : (links.get(d.id)?.nameByUser ?? null);
      // DeviceName und FriendlyName1 nehmen höchstens 32 Zeichen; sonst greift der Typname.
      const haName = linked && settingDef('DeviceName')?.schema.safeParse(linked).success ? linked : null;
      const suggestion = haName ?? suggestions.get(d.id) ?? null;
      return {
        ...d,
        capabilities: capabilitiesOf(raw.get(d.id)?.statusJson, raw.get(d.id)?.sensorsJson, d.module),
        stale: this.isStale(d, links.get(d.id) ?? null),
        ha: links.get(d.id) ?? null,
        pendingCount: counts.get(d.id) ?? 0,
        pendingName,
        nameSuggestion: pendingName || suggestion === d.name ? null : suggestion,
      };
    });
  }

  private isStale(device: Device, link: HaLink | null): boolean {
    if (!this.ha?.ready || !this.ha.linksLoaded || link !== null || device.online) return false;
    const seen = device.lastSeen ? Date.parse(device.lastSeen) : Number.NaN;
    return !Number.isFinite(seen) || this.now().getTime() - seen > STALE_AFTER_MS;
  }

  one(id: string): Device | null {
    return this.all().find((d) => d.id === id) ?? null;
  }
}
