# syntax=docker/dockerfile:1.7
# Alvos: `runner` (imagem de produção, padrão), `migrate` (job de migrations) e `tools` (create-admin).

ARG NODE_VERSION=26
FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ── deps: todas as dependências (inclui a CLI do Prisma) ────────────────────
FROM base AS deps
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci

# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
# `prisma generate` não conecta ao banco; a URL é só para o config carregar.
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate \
 && npm run build

# ── migrate: roda `prisma migrate deploy` com o usuário app_migrator ───────
FROM deps AS migrate
COPY prisma.config.ts ./
COPY prisma ./prisma
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ── tools: código-fonte + dependências, para tarefas operacionais (criar o 1º admin) ──
FROM deps AS tools
COPY . .
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npx prisma generate
USER node
CMD ["npm", "run", "create-admin"]

# ── runner: imagem final, só o necessário (standalone) ─────────────────────
FROM base AS runner
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
