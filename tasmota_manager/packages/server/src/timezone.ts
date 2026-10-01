/** UTC-Versatz einer Zone in Minuten zum Zeitpunkt `at`. */
function offsetMinutes(zone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
}

interface Transition {
  at: number;
  before: number;
  after: number;
}

const HOUR = 3_600_000;

function transitions(zone: string, year: number): Transition[] {
  const result: Transition[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  let previous = offsetMinutes(zone, Date.UTC(year, 0, 1));
  for (let t = Date.UTC(year, 0, 1) + HOUR; t <= end; t += HOUR) {
    const current = offsetMinutes(zone, t);
    if (current === previous) continue;
    // Auf die Minute genau suchen (manche Zonen wechseln zur halben Stunde).
    let at = t - HOUR;
    while (offsetMinutes(zone, at) === previous) at += 60_000;
    result.push({ at, before: previous, after: current });
    previous = current;
  }
  return result;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function rule(t: Transition, hemisphere: number): string {
  // Lokale Zeit vor dem Wechsel: Tasmota-Regeln beziehen sich auf die bis dahin gültige Uhrzeit.
  const local = new Date(t.at + t.before * 60_000);
  const day = local.getUTCDate();
  const month = local.getUTCMonth() + 1;
  const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), month, 0)).getUTCDate();
  const week = day + 7 > daysInMonth ? 0 : Math.ceil(day / 7);
  return [hemisphere, week, month, local.getUTCDay() + 1, local.getUTCHours(), t.after].join(',');
}

/** IANA-Zone → Tasmota: `Timezone 99` mit TimeStd/TimeDst, ohne Sommerzeit ein fester Versatz; null, wenn nicht abbildbar. */
export function tasmotaTimezone(
  zone: string,
  year = new Date().getUTCFullYear(),
): { timezone: string; timeStd: string | null; timeDst: string | null } | null {
  let found: Transition[];
  try {
    found = transitions(zone, year);
  } catch {
    return null;
  }
  if (found.length === 0) return { timezone: formatOffset(offsetMinutes(zone, Date.UTC(year, 0, 1))), timeStd: null, timeDst: null };
  if (found.length !== 2) return null;
  const toDst = found.find((t) => t.after > t.before);
  const toStd = found.find((t) => t.after < t.before);
  if (!toDst || !toStd) return null;
  // Nordhalbkugel: Sommerzeit beginnt im Jahr vor ihrem Ende.
  const hemisphere = toDst.at < toStd.at ? 0 : 1;
  return { timezone: '99', timeStd: rule(toStd, hemisphere), timeDst: rule(toDst, hemisphere) };
}
