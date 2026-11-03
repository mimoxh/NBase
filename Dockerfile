FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.19.0-alpine3.23@sha256:244cc2b53f46f9e876304391d17682b0ddae9ac33491f4857e25e35a36ba7995 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 NBASE_REQUIRE_DATABASE=1 NBASE_ATTACHMENT_DIR=/data/attachments
WORKDIR /app
RUN mkdir -p /data/attachments && chown node:node /data/attachments
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=7s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3001/api/ready',{signal:AbortSignal.timeout(6000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]

FROM runtime AS maintenance
USER root
RUN apk add --no-cache postgresql18-client=18.6-r0
COPY --chown=node:node scripts/backup-engine.mjs ./scripts/backup-engine.mjs
USER node
HEALTHCHECK NONE
ENTRYPOINT ["node", "scripts/backup-engine.mjs"]

FROM runtime AS application
