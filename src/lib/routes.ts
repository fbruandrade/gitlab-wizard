import type { Route } from 'next';

/** `typedRoutes` não aceita hrefs montados em runtime (query string, ids): este cast é o ponto único. */
export const href = (path: string) => path as Route;
