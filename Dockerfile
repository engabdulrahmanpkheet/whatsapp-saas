FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ .
EXPOSE 4000
CMD ["node", "app.js"]
