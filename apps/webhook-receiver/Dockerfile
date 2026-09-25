# Git With Intent - Multi-Source Webhook Receiver
# Epic B: Data Ingestion & Connector Framework
# Task B3.4: Add webhook receiver service
#
# Production-ready Docker image for Cloud Run deployment.
# Optimized for fast startup and small image size.

# Build stage
FROM node:26-alpine AS builder

WORKDIR /app

# Copy root configuration files
COPY package.json ./
COPY package-lock.json ./
COPY tsconfig.json ./

# Copy ALL workspace package.json files (npm ci requires all workspaces to be present)
COPY packages/core/package.json ./packages/core/
COPY packages/agents/package.json ./packages/agents/
COPY packages/integrations/package.json ./packages/integrations/
COPY packages/engine/package.json ./packages/engine/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/connectors/package.json ./packages/connectors/
COPY apps/api/package.json ./apps/api/
COPY apps/cli/package.json ./apps/cli/
COPY apps/gateway/package.json ./apps/gateway/
COPY apps/github-webhook/package.json ./apps/github-webhook/
COPY apps/registry/package.json ./apps/registry/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY apps/webhook-receiver/package.json ./apps/webhook-receiver/

# Install all dependencies (--ignore-scripts skips husky prepare)
RUN npm ci --ignore-scripts

# Copy source files
COPY packages/core ./packages/core
COPY apps/webhook-receiver ./apps/webhook-receiver

# Build core first, then webhook-receiver
RUN npm run build --workspace=@gwi/core
RUN npm run build --workspace=@gwi/webhook-receiver

# Production stage
FROM node:26-alpine AS runner

WORKDIR /app

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 webhook

# Copy built files
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/apps/webhook-receiver/dist ./apps/webhook-receiver/dist
COPY --from=builder /app/apps/webhook-receiver/package.json ./apps/webhook-receiver/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Set ownership
RUN chown -R webhook:nodejs /app

# Switch to non-root user
USER webhook

# Environment
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start from webhook-receiver workspace
WORKDIR /app/apps/webhook-receiver
CMD ["node", "dist/index.js"]
