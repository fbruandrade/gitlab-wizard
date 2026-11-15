# 10 — Dependências e versões

Versões **exatas** (`save-exact=true`, lockfile versionado) consultadas no npm em **13/11/2026**. Revalide no início de cada ciclo (`npm view <pkg> version`).

## 1. Runtime e infraestrutura

| Item | Versão |
|------|--------|
| Node.js | **26 LTS** (`node:26-alpine` nas imagens) |
| PostgreSQL | **18** (`postgres:18-alpine`) |
| Docker / Compose | 29 / v5 (testado) |

## 2. Pacotes

### Produção
| Pacote | Versão | Papel |
|--------|--------|-------|
| `next` | 16.4.6 | App Router, Turbopack, `proxy.ts`, `output: 'standalone'` |
| `react` / `react-dom` | 19.3.1 | |
| `better-auth` | 1.7.22 | Plugins `username`, `twoFactor`, `admin`, `nextCookies` |
| `@prisma/client` + `@prisma/adapter-pg` | 7.10.1 | ORM + driver adapter |
| `pg` | 8.23.1 | |
| `undici` | 8.12.4 | `fetch` + `Agent` do GitLab (a opção de TLS auto-assinado) |
| `zod` | 4.6.7 | |
| `react-hook-form` + `@hookform/resolvers` | 7.92.0 / 7.0.6 | |
| `@base-ui/react`, `cn`, `class-variance-authority`, `lucide-react`, `sonner`, `input-otp`, `next-themes` | 1.9.0 / 0.5.2 / 0.7.1 / 1.72.0 / 2.0.8 / 1.5.0 / 0.4.6 | Base do shadcn/ui |
| `qrcode.react` | 4.2.0 | QR do TOTP |
| `date-fns` + `@date-fns/tz` | 4.4.0 / 1.5.0 | Datas em `America/Sao_Paulo` |
| `pino` | 10.4.0 | Logs com `redact` |

### Desenvolvimento
`typescript` **6.0.3** · `prisma` 7.10.1 · `auth` 1.7.22 (CLI do better-auth) · `tailwindcss` + `@tailwindcss/postcss` 4.3.5 · `shadcn` 4.23.0 + `tw-animate-css` 1.4.0 (só CSS/CLI de build) · `eslint` 10.14.0 + `eslint-config-next` 16.4.6 · `prettier` 3.10.1 · `vitest` 5.1.0 · `@playwright/test` 1.65.0 + `@axe-core/playwright` 4.14.0 · `@testcontainers/postgresql` 12.2.1 · `otpauth` 9.6.0 · `tsx` 4.23.15 · `pino-pretty`.

## 3. Incompatibilidades e decisões

| Situação | Decisão |
|----------|---------|
| `typescript@latest` é a **7.0.2**, mas o `typescript-eslint` declara peer `<6.1.0` | Fixado **6.0.3**; Renovate com `allowedVersions: <6.1.0` |
| O dist-tag `latest` do CLI `prisma` já apontou para um **RC 8.x**; o better-auth só suporta Prisma ≤ 7 | CLI e client fixados em **7.10.1**; Renovate ignora versões instáveis |
| A CLI do better-auth agora é o pacote `auth` | `npm run auth:generate` |
| O `shadcn init` atual usa **`@base-ui/react`** (não Radix) e a utilidade `cn` vem do pacote `cn` (mantido por `shadcn-ui`) | Adotado; removidos `radix-ui`, `clsx`, `tailwind-merge` que eu havia previsto |
| `shadcn` (CLI) entrou como `dependency` e puxava `ts-morph/minimatch` (6 avisos `npm audit` na árvore de produção) | Movido para `devDependencies` → **0 vulnerabilidades em produção** |
| MSW, TanStack Table e Radix constavam no plano | **Não usados**: GitLab falso próprio (ver 09); tabelas HTML simples; base-ui |
| Next 16: `middleware.ts` → `proxy.ts`; sem `next lint`; `params`/`searchParams`/`headers()` assíncronos; `next typegen` para tipos de rotas | Aplicado; `typecheck` roda `next typegen` antes do `tsc` |
| Prisma 7: URL fora do schema (`prisma.config.ts`), generator `prisma-client` com `output`, adapter obrigatório, sem `.env` automático | Aplicado (`process.loadEnvFile`) |
| `package.json` sem `"type": "module"` | Scripts de operação são `.mts` (top-level await) |

## 4. Política de atualização
`renovate.json` (já no repositório): versões exatas; `minimumReleaseAge: 3 days`; grupos `next+react`, `prisma`, `better-auth`; **sem automerge** em `next`, `better-auth`, `prisma` e em qualquer major; nada de RC/beta/canary. CI: `npm audit --omit=dev --audit-level=moderate` (produção deve ficar em **0**) e `npm audit --audit-level=high` (tudo). Hoje restam 18 avisos *moderados* só em ferramentas de desenvolvimento (`eslint`/`typescript-eslint`, `testcontainers`), fora da imagem de produção.
