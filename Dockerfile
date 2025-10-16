# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    CI=1
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml ./

FROM base AS deps
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN pnpm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable pnpm

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/public ./public
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/pnpm-lock.yaml ./pnpm-lock.yaml
RUN if [ -f next.config.js ]; then cp next.config.js ./; fi
RUN if [ -f next.config.mjs ]; then cp next.config.mjs ./; fi
RUN if [ -f next.config.ts ]; then cp next.config.ts ./; fi
RUN pnpm prune --prod

EXPOSE 3000
CMD ["pnpm", "run", "start"]
