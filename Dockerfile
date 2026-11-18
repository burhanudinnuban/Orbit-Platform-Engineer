# Orbit API, workers and portal in one image. docker-compose.yml runs it as
# service `orbit` (profile orbit): npm run bootstrap -- --orbit

# ═══════════════════════════════════════════
# STAGE 1: Build the API (tsc) and the portal (Vite)
# ═══════════════════════════════════════════
FROM node:22-alpine AS builder

WORKDIR /app

# Install deps first (better layer caching). The portal is an npm workspace.
COPY package.json package-lock.json ./
COPY portal/package.json ./portal/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# The server serves the portal only when its build exists; fail here instead.
RUN test -s /app/portal/dist/index.html && test -s /app/dist/main.js

# Production dependencies only for the runtime stage
RUN npm prune --omit=dev --no-audit --no-fund


# ═══════════════════════════════════════════
# STAGE 2: Runtime
# ═══════════════════════════════════════════
FROM node:22-alpine AS runner

# Orbit seeds repositories and commits to the gitops repo with the git CLI.
RUN apk add --no-cache git

WORKDIR /app
ENV NODE_ENV=production \
  ORBIT_HOST=0.0.0.0 \
  ORBIT_DATA_DIR=/var/lib/orbit

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/portal/dist ./portal/dist
# Read at runtime: app templates, gitops manifest templates and Terraform modules.
COPY templates ./templates
COPY terraform ./terraform

RUN mkdir -p /var/lib/orbit && chown node:node /var/lib/orbit
USER node

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1

CMD ["node", "dist/main.js"]
