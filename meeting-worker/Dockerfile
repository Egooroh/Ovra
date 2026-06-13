FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY prisma ./prisma
COPY proto ./proto
COPY src ./src
RUN NODE_OPTIONS=--max-old-space-size=1536 npm run build
RUN npx prisma generate

FROM node:20-slim
WORKDIR /app

# System deps: openssl (Prisma), Xvfb (virtual display), PulseAudio (audio), Playwright deps
RUN apt-get update && apt-get install -y \
    openssl \
    xvfb \
    pulseaudio \
    pulseaudio-utils \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/proto ./proto
COPY package.json ./
COPY prisma ./prisma
COPY scripts/docker-entrypoint.sh /entrypoint.sh
# Strip any CRLF (Windows checkout) so the shebang resolves on Linux, then chmod.
RUN sed -i 's/\r$//' /entrypoint.sh && chmod +x /entrypoint.sh

# Install Playwright's Chromium with all system dependencies
RUN npx playwright install --with-deps chromium

ENV DISPLAY=:99

ENTRYPOINT ["/entrypoint.sh"]
