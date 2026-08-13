FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY agent.mjs ./
CMD ["node", "agent.mjs"]
