FROM node:24-slim
WORKDIR /app
COPY ingest/package.json ./
RUN npm install --omit=dev
COPY ingest/src ./src
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "src/index.ts"]
