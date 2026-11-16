import { defineConfig } from 'vitest/config';

/**
 * Cobertura de código: roda os testes UNITÁRIOS e os de INTEGRAÇÃO num só processo do Vitest e mescla a cobertura.
 * (As duas suítes cobrem partes diferentes do código: medir separado subestimaria cada uma.)
 *
 *   npm run test:coverage      → relatório no terminal + coverage/index.html + coverage/lcov.info
 *
 * O que entra na conta: a lógica de servidor e as regras compartilhadas (`src/server`, `src/lib`) e a borda HTTP
 * testada sem navegador (Server Actions `actions.ts` e route handlers `route.ts`, exercitados com os módulos do Next simulados).
 * Fica de fora, de propósito:
 *  - telas/componentes React (`page.tsx`, `layout.tsx`, `src/components`): exercitados pelo E2E (Playwright), que roda num
 *    navegador e não passa pelo instrumentador do Vitest;
 *  - `src/lib/routes.ts` e `src/lib/auth-client.ts`: um cast de tipos e a fiação do client do better-auth (sem lógica);
 *  - `src/components/ui` (shadcn gerado), `src/generated` (Prisma), `src/proxy.ts`/`src/instrumentation.ts` (hooks do Next).
 */
export default defineConfig({
  test: {
    projects: ['vitest.config.mts', 'vitest.integration.config.mts'],
    coverage: {
      provider: 'v8',
      include: ['src/server/**/*.ts', 'src/lib/**/*.ts', 'src/app/**/actions.ts', 'src/app/**/route.ts'],
      exclude: ['**/*.d.ts', 'src/server/auth/auth.generate.ts', 'src/lib/routes.ts', 'src/lib/auth-client.ts'], // auth.generate: config só da CLI do better-auth
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary', 'cobertura'], // cobertura: o GitLab CI mostra a cobertura no MR
      reportsDirectory: 'coverage',
      reportOnFailure: true, // mesmo com teste falhando, gera o relatório (útil para depurar)
      /**
       * Limites MÍNIMOS: o comando falha (exit 1) se a cobertura cair abaixo. Ficam um pouco abaixo do atual
       * (96,9 / 90,3 / 95,8 / 98,7) para pegar regressão sem quebrar por oscilação. NÃO baixe para "fazer passar":
       * escreva o teste. Nos módulos de segurança o piso é 100%.
       */
      thresholds: {
        statements: 95,
        branches: 88,
        functions: 94,
        lines: 97,
        // ── onde um furo de teste é um furo de segurança ──
        'src/server/crypto/**': { statements: 100, branches: 100, functions: 100, lines: 100 }, // cifragem do PAT
        'src/server/auth/capabilities.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/server/action-result.ts': { statements: 100, branches: 100, functions: 100, lines: 100 }, // não vazar erro interno
        'src/server/auth/guards.ts': { statements: 100, branches: 94, functions: 100, lines: 100 }, // sessão, gates, papel de admin
        'src/lib/vault-rules.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/cleanup-rules.ts': { statements: 100, branches: 100, functions: 100, lines: 100 }, // o que a limpeza revoga
        'src/lib/schemas.ts': { statements: 100, branches: 100, functions: 100, lines: 100 }, // validação de entrada
        'src/lib/admin-schemas.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/password-policy.ts': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'src/lib/csv.ts': { statements: 100, branches: 100, functions: 100, lines: 100 }, // injeção de fórmula
        'src/server/services/gitlab-token.service.ts': { statements: 90, branches: 80, functions: 88, lines: 93 },
        'src/server/gitlab/client.ts': { statements: 97, branches: 95, functions: 95, lines: 98 },
      },
    },
  },
});
