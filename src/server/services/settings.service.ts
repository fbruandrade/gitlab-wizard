import 'server-only';
import { ActionError } from '@/server/action-result';
import { prisma } from '@/server/db';
import { env } from '@/server/env';
import { SETTING_BOUNDS, type SettingName } from '@/lib/settings';
import { recordAudit, type RequestMeta } from './audit.service';

const KEYS: Record<SettingName, string> = { cleanupInactivityDays: 'cleanup.inactivityDays', patMaxLifetimeDays: 'pat.maxLifetimeDays' };

export type Settings = Record<SettingName, number>;

const valid = (name: SettingName, v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= SETTING_BOUNDS[name].min && v <= SETTING_BOUNDS[name].max;

/** Valores salvos na interface; na ausência (ou valor inválido), o padrão: 90 dias / TOKEN_MAX_LIFETIME_DAYS do .env. */
export async function getSettings(): Promise<Settings> {
  const rows = await prisma.appSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  const pick = (name: SettingName, fallback: number) => {
    const v = stored.get(KEYS[name]);
    return valid(name, v) ? v : fallback;
  };
  return {
    cleanupInactivityDays: pick('cleanupInactivityDays', SETTING_BOUNDS.cleanupInactivityDays.default),
    patMaxLifetimeDays: pick('patMaxLifetimeDays', env.TOKEN_MAX_LIFETIME_DAYS),
  };
}

export async function updateSetting(
  ctx: { actor: { id: string; username?: string | null }; meta?: RequestMeta },
  name: SettingName,
  value: unknown,
  reason?: string,
) {
  if (!valid(name, value))
    throw new ActionError(
      'INVALID_SETTING',
      `${SETTING_BOUNDS[name].label}: informe um inteiro entre ${SETTING_BOUNDS[name].min} e ${SETTING_BOUNDS[name].max}.`,
    );
  const before = (await getSettings())[name];
  await prisma.appSetting.upsert({
    where: { key: KEYS[name] },
    create: { key: KEYS[name], value, updatedBy: ctx.actor.id },
    update: { value, updatedBy: ctx.actor.id },
  });
  await recordAudit({
    action: 'SETTINGS_CHANGED',
    result: 'SUCCESS',
    actor: ctx.actor,
    meta: ctx.meta,
    reason,
    metadata: { setting: KEYS[name], from: before, to: value },
  });
  return value;
}
