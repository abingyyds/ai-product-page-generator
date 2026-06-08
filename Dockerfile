FROM node:22-bookworm-slim AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts/apply-prisma-migrations.cjs ./scripts/apply-prisma-migrations.cjs
COPY --from=builder /app/scripts/runtime-paths.cjs ./scripts/runtime-paths.cjs
COPY --from=builder /app/scripts/railway-start.cjs ./scripts/railway-start.cjs

EXPOSE 3000

CMD ["node", "scripts/railway-start.cjs"]
