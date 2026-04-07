FROM node:20-alpine AS builder

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
COPY scripts/ ./scripts/

RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

RUN apk add --no-cache curl python3 make g++

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./

RUN npm ci --omit=dev

ENV NODE_ENV=production

EXPOSE 3000

RUN mkdir -p /app/data && chown -R node:node /app

USER node

CMD ["node", "dist/index.js"]
