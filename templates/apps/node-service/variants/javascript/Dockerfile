FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080
# npm, npx, corepack and yarn are build tools. The base image ships them with
# their own dependencies, which carry CVEs the app never uses; removing them
# keeps those out of the running container and out of the Trivy image scan.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
# Numeric UID so Kubernetes can verify runAsNonRoot.
USER 10001
EXPOSE 8080
CMD ["node", "src/index.js"]
