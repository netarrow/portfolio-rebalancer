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
# Helper to tell Puppeteer to skip downloading Chrome if we want to use the installed google-chrome-stable, 
# BUT usually Puppeteer uses its own revision.
# Installing google-chrome-stable mainly ensures all shared libs are present.
# However, to be safe and use Puppeteer's internal generic chrome, we just let it download in 'npm install'.
# We also set PORT to 80.
ENV PORT=80
ENV NODE_ENV=production

# Command to run the application
CMD [ "node", "server/index.js" ]
