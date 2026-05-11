FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY package.json ./

ENV ANTLEGION_BUS_URL=http://antlegion-bus:28080
CMD ["node", "dist/index.js"]
