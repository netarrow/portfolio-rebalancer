FROM node:20-slim

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chromium that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set up working directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies (including puppeteer)
# Note: npm ci is generally better for CI/Docker builds but user might just have package.json without lock or sync issues, so npm install is safer for dev-like envs, but for prod docker npm ci is standard. Using npm install for robustness here unless lockfile exists.
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
