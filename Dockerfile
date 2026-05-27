# AntLegion v2 — append-only fact bus, run it like you run redis.
# Build context is the repo root; the source package lives in antlegion-bus/.
#
#   docker build -t antlegion-v2 .          # run from the repo root
#   docker run -p 28090:28090 -v antlegion-data:/data \
#     -e ANTLEGION_BUS_SECRET=change-me -e ANTLEGION_FSYNC=everysec antlegion-v2
FROM node:20-alpine AS build
WORKDIR /app
COPY antlegion-bus/package*.json antlegion-bus/tsconfig.json ./
RUN npm ci
COPY antlegion-bus/src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=28090
ENV ANTLEGION_DATA_DIR=/data
ENV ANTLEGION_FSYNC=everysec
COPY antlegion-bus/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
VOLUME ["/data"]
EXPOSE 28090
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://localhost:28090/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
