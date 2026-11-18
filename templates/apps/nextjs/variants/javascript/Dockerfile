FROM node:26-alpine AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
# One install for both stages: build, then drop the dev dependencies. npm
# installs both the glibc and the musl builds of the native packages (SWC,
# sharp); the image runs on Alpine, so only musl stays (about 115 MB less).
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && rm -rf .next/cache node_modules/@next/swc-*-gnu node_modules/@img/sharp-linux-* node_modules/@img/sharp-libvips-linux-*

FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=8080
# npm, npx, corepack and yarn are build tools. The base image ships them with
# their own dependencies, which carry CVEs the app never uses; removing them
# keeps those out of the running container and out of the Trivy image scan.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json next.config.mjs server.js ./
COPY server ./server
COPY public ./public
COPY --from=build /app/.next ./.next
# The root filesystem is read-only in Kubernetes. Next.js writes its runtime
# cache (optimized images, regenerated pages) to .next/cache, so that points
# at /tmp, the pod's one writable directory.
RUN ln -s /tmp .next/cache
# Numeric UID so Kubernetes can verify runAsNonRoot.
USER 10001
EXPOSE 8080
CMD ["node", "server.js"]
