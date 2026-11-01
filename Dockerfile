# Multi-stage Dockerfile for NestJS Hisobchi Bot
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install dependencies including Prisma engine
RUN apk add --no-cache openssl libc6-compat

COPY package*.json ./
COPY prisma ./prisma/

RUN npm ci

COPY . .

RUN npx prisma generate
RUN npm run build

# Production image
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

RUN apk add --no-cache openssl libc6-compat tzdata

ENV NODE_ENV=production
ENV TZ=Asia/Tashkent

COPY package*.json ./
COPY prisma ./prisma/
COPY scripts ./scripts/

RUN npm ci --only=production
RUN npx prisma generate

COPY --from=builder /usr/src/app/dist ./dist

EXPOSE 3000

CMD ["node", "scripts/prestart.js"]


