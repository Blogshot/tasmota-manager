# Der Supervisor übergibt BUILD_FROM/BUILD_VERSION; die App nutzt bewusst das offizielle Node-Image.
# Kein Compiler nötig: better-sqlite3 bringt vorkompilierte Binaries für Alpine (amd64, aarch64) mit.
FROM node:22-alpine AS build
RUN npm install -g pnpm@10
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
# Ohne Install-Skripte: Für den Build braucht es kein natives better-sqlite3 (das kommt in der Laufzeit-Stufe).
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY packages ./packages
# Nur bündeln; Typecheck und Tests laufen in der CI, nicht auf dem Home-Assistant-Gerät.
RUN pnpm --filter @tm/web exec vite build && pnpm --filter @tm/server build
# Laufzeitabhängigkeiten: nur das native better-sqlite3, alles andere steckt im Bundle.
RUN mkdir -p /out/server /out/web \
 && cp -r packages/server/dist packages/server/drizzle /out/server/ \
 && cp -r packages/web/dist /out/web/ \
 && cd /out/server \
 && echo '{"type":"module","dependencies":{"better-sqlite3":"^13.0.3"}}' > package.json \
 && npm install --omit=dev --no-audit --no-fund

FROM node:22-alpine
ARG BUILD_VERSION=dev
ENV NODE_ENV=production TM_VERSION=${BUILD_VERSION}
WORKDIR /app
COPY --from=build /out/ /app/
EXPOSE 8099
CMD ["node", "/app/server/dist/server.js"]
