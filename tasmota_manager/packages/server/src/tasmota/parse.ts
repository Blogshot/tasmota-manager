import { intToIp, parseCidr } from '@tm/shared';

export interface DeviceInfo {
  mac: string;
  name?: string;
  hostname?: string;
  ip?: string;
  mqttTopic?: string;
  fullTopic?: string;
  module?: string;
  firmware?: string;
  variant?: string;
  chip?: string;
  flashSize?: number;
  rssi?: number;
  uptimeSec?: number;
}

type Json = Record<string, unknown>;

export const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown): Json => (isObj(v) ? v : {});

/** Nur gültige IPv4-Adressen ungleich 0.0.0.0, damit Broker-Nachrichten keine fremden Hosts einschleusen. */
function ipv4(v: unknown): string | undefined {
  if (typeof v !== 'string' || /\s/.test(v)) return undefined;
  const parsed = parseCidr(`${v}/32`);
  return parsed && parsed.base !== 0 ? intToIp(parsed.base) : undefined;
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function normalizeMac(mac: unknown): string | null {
  if (typeof mac !== 'string') return null;
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return hex.length === 12 ? hex : null;
}

export function parseVersion(version: unknown): { firmware?: string; variant?: string } {
  const v = str(version);
  if (!v) return {};
  const m = /^([\d.]+)(?:\((.+)\))?/.exec(v);
  if (!m) return { firmware: v };
  return { firmware: m[1], variant: m[2]?.replace(/^release-/, '') };
}

export function parseStatus0(payload: unknown): DeviceInfo | null {
  if (!isObj(payload)) return null;
  const status = obj(payload.Status);
  const fwr = obj(payload.StatusFWR);
  const net = obj(payload.StatusNET);
  const sts = obj(payload.StatusSTS);
  const mem = obj(payload.StatusMEM);
  const mac = normalizeMac(net.Mac);
  if (!mac) return null;
  const friendly = Array.isArray(status.FriendlyName) ? str(status.FriendlyName[0]) : undefined;
  return {
    mac,
    name: friendly ?? str(status.DeviceName),
    hostname: str(net.Hostname),
    // ESP32 mit Ethernet meldet IPAddress 0.0.0.0 und die echte Adresse unter Ethernet.
    ip: ipv4(obj(net.Ethernet).IPAddress) ?? ipv4(net.IPAddress),
    mqttTopic: str(status.Topic),
    chip: str(fwr.Hardware),
    flashSize: num(mem.FlashSize),
    rssi: num(obj(sts.Wifi).Signal),
    uptimeSec: num(sts.UptimeSec),
    ...parseVersion(fwr.Version),
  };
}

export function parseDiscoveryConfig(payload: unknown): DeviceInfo | null {
  if (!isObj(payload)) return null;
  const mac = normalizeMac(payload.mac);
  const topic = str(payload.t);
  if (!mac || !topic) return null;
  const friendly = Array.isArray(payload.fn) ? str(payload.fn[0]) : undefined;
  return {
    mac,
    name: friendly ?? str(payload.dn),
    hostname: str(payload.hn),
    ip: ipv4(payload.ip),
    mqttTopic: topic,
    fullTopic: str(payload.ft),
    module: str(payload.md),
    ...parseVersion(payload.sw),
  };
}

export function parseState(payload: unknown): { rssi?: number; uptimeSec?: number } {
  if (!isObj(payload)) return {};
  return { rssi: num(obj(payload.Wifi).Signal), uptimeSec: num(payload.UptimeSec) };
}

export function parseModule(payload: unknown): string | null {
  if (!isObj(payload) || !isObj(payload.Module)) return null;
  const first = Object.values(payload.Module)[0];
  return typeof first === 'string' ? first : null;
}
