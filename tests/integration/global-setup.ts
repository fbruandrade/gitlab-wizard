import type { TestProject } from 'vitest/node';
import { startTestPostgres } from '../support/pg-container';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    migrationUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const db = await startTestPostgres();
  project.provide('databaseUrl', db.databaseUrl);
  project.provide('migrationUrl', db.migrationUrl);
  return async () => {
    await db.stop();
  };
}
