# ─────────────────────────────────────────────────────────────────────────
# Trigger.dev v3 Worker - Aurelius Autonomous Workbench
# ─────────────────────────────────────────────────────────────────────────
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

WORKDIR /app

# Install system dependencies required by pdf-parse and archiver
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests and install dependencies
COPY package.json ./
RUN npm install --production=false

# Copy source code
COPY . .

# Build / type-check
RUN npx tsc --noEmit || true

# Default command: run the Trigger.dev dev worker
CMD ["npx", "trigger", "dev"]
