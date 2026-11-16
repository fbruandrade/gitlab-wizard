import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Segurança: nunca injetar HTML cru (ver docs/06-seguranca.md §6).
      'react/no-danger': 'error',
    },
  },
  globalIgnores(['coverage/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts', 'src/generated/**']),
]);
