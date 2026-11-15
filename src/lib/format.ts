import { TZDate } from '@date-fns/tz';
import { differenceInCalendarDays, format } from 'date-fns';

const TZ = 'America/Sao_Paulo';

export const formatDateTime = (d: Date | string | null | undefined) => (d ? format(new TZDate(new Date(d), TZ), 'dd/MM/yyyy HH:mm') : '—');
export const formatDate = (d: Date | string | null | undefined) => (d ? format(new TZDate(new Date(d), TZ), 'dd/MM/yyyy') : '—');
export const daysUntil = (d: Date | string | null | undefined, now = new Date()) =>
  d ? differenceInCalendarDays(new TZDate(new Date(d), 'UTC'), new TZDate(now, 'UTC')) : null;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';
