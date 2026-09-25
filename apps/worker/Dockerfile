# Git With Intent - Worker Service
# Phase 35: Background job processor for autopilot workflows

# Build stage
FROM node:26-alpine AS builder

WORKDIR /app

# Install git for workspace isolation (cloning repos)
RUN apk add --no-cache git

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
COPY apps/api/package.json ./apps/api/
COPY apps/cli/package.json ./apps/cli/
COPY apps/gateway/package.json ./apps/gateway/
COPY apps/github-webhook/package.json ./apps/github-webhook/
COPY apps/registry/package.json ./apps/registry/
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/

# Install all dependencies (--ignore-scripts skips husky prepare)
# Full npm ci is needed because firebase-admin and better-sqlite3 are root dependencies
RUN npm ci --ignore-scripts

# Copy source files
COPY packages/core ./packages/core
COPY packages/agents ./packages/agents
COPY packages/engine ./packages/engine
COPY packages/integrations ./packages/integrations
COPY apps/worker ./apps/worker

# Build in dependency order
RUN npm run build --workspace=@gwi/core
RUN npm run build --workspace=@gwi/agents
RUN npm run build --workspace=@gwi/integrations
RUN npm run build --workspace=@gwi/engine
RUN npm run build --workspace=@gwi/worker

# Production stage
FROM node:26-alpine AS runner

WORKDIR /app

# Install git for workspace isolation (needed at runtime for cloning)
RUN apk add --no-cache git

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 worker

# Create workspace directory for autopilot jobs
RUN mkdir -p /tmp/gwi-workspaces && chown worker:nodejs /tmp/gwi-workspaces

# Copy built files
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/core/package.json ./packages/core/
COPY --from=builder /app/packages/agents/dist ./packages/agents/dist
COPY --from=builder /app/packages/agents/package.json ./packages/agents/
COPY --from=builder /app/packages/engine/dist ./packages/engine/dist
COPY --from=builder /app/packages/engine/package.json ./packages/engine/
COPY --from=builder /app/packages/integrations/dist ./packages/integrations/dist
COPY --from=builder /app/packages/integrations/package.json ./packages/integrations/
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/package.json ./apps/worker/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Set ownership
RUN chown -R worker:nodejs /app

# Switch to non-root user
USER worker

# Environment
ENV NODE_ENV=production
ENV PORT=8080
ENV GWI_WORKSPACE_DIR=/tmp/gwi-workspaces

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Start from worker workspace
WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
