FROM node:22-bookworm-slim AS web
WORKDIR /app/apps/web
COPY apps/web/package.json ./
RUN npm install --no-audit --no-fund
COPY apps/web ./
RUN npm run build

FROM node:22-bookworm-slim
ARG WITH_BROWSER=true
WORKDIR /app
ENV NODE_ENV=production CONFLUX_HOST=0.0.0.0 CONFLUX_DATA_DIR=/data PORT=8787
COPY package.json ./
RUN if [ "$WITH_BROWSER" = "true" ]; then npm install --no-audit --no-fund --omit=dev playwright && npx playwright install --with-deps chromium; fi
COPY packages ./packages
COPY apps/server ./apps/server
COPY bin ./bin
COPY skills ./skills
COPY examples ./examples
COPY --from=web /app/apps/web/dist ./apps/web/dist
VOLUME /data
EXPOSE 8787
CMD ["node", "apps/server/src/main.ts"]
