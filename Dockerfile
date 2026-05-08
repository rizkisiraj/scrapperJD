FROM node:20-alpine

WORKDIR /app

# Install deps first (layer cached unless package.json changes)
COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

# Expose API port
EXPOSE 3000

# Default: start the API server
# Override with CMD when running the scheduler container
CMD ["node", "src/api/server.js"]
