# Der Supervisor übergibt BUILD_FROM/BUILD_VERSION; die App nutzt bewusst das offizielle Node-Image.
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++ \
 && npm install -g pnpm@10
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages ./packages
RUN pnpm build
# Laufzeitabhängigkeiten: nur das native better-sqlite3, alles andere steckt im Bundle.
RUN mkdir -p /out/server /out/web \
 && cp -r packages/server/dist packages/server/drizzle /out/server/ \
 && cp -r packages/web/dist /out/web/ \
 && cd /out/server \
 && echo '{"type":"module","dependencies":{"better-sqlite3":"^13.0.3"}}' > package.json \
 && npm install --omit=dev

FROM node:22-alpine
ARG BUILD_VERSION=dev
ENV NODE_ENV=production TM_VERSION=${BUILD_VERSION}
WORKDIR /app
COPY --from=build /out/ /app/
EXPOSE 8099
CMD ["node", "/app/server/dist/server.js"]
