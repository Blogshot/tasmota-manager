interface HaContext {
  darkMode?: boolean;
  language?: string;
}

type HassElement = Element & { hass?: { language?: string; themes?: { darkMode?: boolean } } };

/** Liest Sprache und Dark Mode aus dem umgebenden HA-Frontend (Ingress läuft same-origin im iframe). */
export function readHaContext(): HaContext {
  try {
    if (window.parent === window) return {};
    const root = window.parent.document.querySelector('home-assistant') as HassElement | null;
    const hass = root?.hass;
    if (!hass) return {};
    return { darkMode: hass.themes?.darkMode, language: hass.language };
  } catch {
    return {};
  }
}

export function applyTheme(): void {
  const dark = readHaContext().darkMode ?? window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  document.documentElement.classList.toggle('dark', dark);
}
