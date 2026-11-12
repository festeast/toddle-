# syntax=docker/dockerfile:1
# Многоэтапная сборка. Финальные образы — distroless: только Node.js и libssl, без shell и пакетного менеджера,
# запуск от непривилегированного пользователя nonroot (uid 65532).

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Движки Prisma для финального образа (distroless / Debian 12, OpenSSL 3), независимо от сборочного образа
ENV PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build

# Служебный образ: миграции (по умолчанию), первичная настройка школы, импорт.
#   docker compose -f docker-compose.prod.yml run --rm tools                       → prisma migrate deploy
#   docker compose -f docker-compose.prod.yml run --rm tools node_modules/tsx/dist/cli.mjs scripts/setup-school.ts ...
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS tools
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["node_modules/prisma/build/index.js", "migrate", "deploy"]

FROM gcr.io/distroless/nodejs22-debian12:nonroot AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=nonroot:nonroot /app/.next/standalone ./
COPY --from=build --chown=nonroot:nonroot /app/.next/static ./.next/static
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["server.js"]

# Railway собирает ПОСЛЕДНЮЮ стадию Dockerfile. Она сама применяет миграции при каждом старте
# (и заполняет демо-данными пустую базу при SEED_DEMO=true). docker-compose.prod.yml берёт
# стадии runner/tools явно, поэтому эта стадия на него не влияет.
FROM gcr.io/distroless/nodejs22-debian12:nonroot AS railway
WORKDIR /app
ENV NODE_ENV=production HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=nonroot:nonroot /app /app
CMD ["scripts/railway-start.cjs"]
