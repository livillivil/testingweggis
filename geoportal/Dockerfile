# syntax=docker/dockerfile:1.7
# ============================================================
# KMC Public GeoPortal — Golden multi-stage build
#   Build base : oven/bun:1.4.4-alpine
#   Runtime    : node:22.23.4-alpine
#
# Mandatory policy:
#   * exact dependency pin: next-auth@5.0.0-beta.32
#   * every build runs `bun audit` and fails on known vulnerabilities
#   * the final image ships only the standalone Next.js server (basePath
#     /geoportal), no Bun and no dev dependencies
# ============================================================

FROM oven/bun:1.4.4-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json bun.lock ./
RUN set -e; \
    attempt=1; \
    until bun install --frozen-lockfile; do \
        if [ "$attempt" -ge 3 ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
        attempt=$((attempt + 1)); \
    done

FROM deps AS audit
RUN set -e; \
    attempt=1; \
    until bun audit; do \
        if [ "$attempt" -ge 3 ]; then exit 1; fi; \
        sleep $((attempt * 5)); \
        attempt=$((attempt + 1)); \
    done

FROM audit AS builder
ENV NODE_ENV=production
COPY . .
RUN bun run build

FROM node:22.23.4-alpine AS runner
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
USER nextjs
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "server.js"]
