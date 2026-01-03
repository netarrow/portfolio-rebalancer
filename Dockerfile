FROM node:20-slim

# Install chromium and fonts to support major charsets
RUN apt-get update \
  && apt-get install -y chromium fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Tell Puppeteer to skip installing Chrome. We'll use the installed package.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
  PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install dependencies
# Note: npm ci is generally better for CI/Docker builds but user might just have package.json without lock or sync issues.
RUN npm install

# Copy application source
COPY . .

# Build the frontend
RUN npm run build

# Expose port 80
EXPOSE 80

# Environment variables
# Default to production/80 for the container (Azure/Deployment)
# Can be overridden at runtime for local dev (e.g., -e PORT=3001 -e NODE_ENV=development)
ENV PORT=80
ENV NODE_ENV=production

# Command to run the application
CMD [ "node", "server/index.js" ]
