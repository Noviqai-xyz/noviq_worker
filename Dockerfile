FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install
COPY tsconfig.json fleet.config.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY fleet.config.json ./
# Persist provisioned tokens here (mount a volume at /data).
ENV TOKENS_CACHE=/data/.tokens.json
CMD ["node", "dist/fleet.js"]
