import { readFileSync } from 'node:fs';
import pg from 'pg';
import { Secret, TOTP } from 'otpauth';

export interface State {
  appUrl: string;
  adminPassword: string;
  adminPat: string;
  rotateOnlyPat: string;
  controlUrl: string;
  migrationUrl: string;
  maintenanceSecret: string;
  gitlabUrl: string;
}
export const state = (): State => JSON.parse(readFileSync('tests/e2e/.state.json', 'utf8'));

/** Cliente da porta de controle do GitLab falso. */
export const control = {
  async get<T>(path: string): Promise<T> {
    return (await fetch(`${state().controlUrl}${path}`)).json() as Promise<T>;
  },
  async post<T>(path: string, body: unknown = {}): Promise<T> {
    return (await fetch(`${state().controlUrl}${path}`, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<T>;
  },
};

export const totp = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30 }).generate();

export async function sql<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: state().migrationUrl });
  await c.connect();
  try {
    return (await c.query(query, params)).rows as T[];
  } finally {
    await c.end();
  }
}

export const NEW_PASSWORD = 'N0va!SenhaForte#42';
export const OPERATOR_PASSWORD = 'Operad0r!Forte#77';
