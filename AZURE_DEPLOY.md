# Deploying Portfolio Rebalancer to Azure App Service

This guide outlines the steps to deploy the application to Azure Web App (App Service).

## Prerequisites

- An Azure Account.
- Azure CLI installed (optional, can use Portal).
- The project pushed to a GitHub repository.

## 1. App Service Creation

1.  Go to the Azure Portal and create a new **Web App**.
2.  **Publish**: Code
3.  **Runtime stack**: Node 20 LTS (or latest LTS available).
4.  **Operating System**: Linux (Recommended for cost and performance).
5.  **Plan**: Basic (B1) or higher is recommended. Free (F1) might work but could be slow for builds.

## 2. Configuration (Environment Variables)

Go to **Settings** -> **Environment variables** in your App Service blade.

Add the following settings:

| Name | Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Ensures the app runs in production mode. |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | `true` | **Optional**: Use if you install Chrome separately or use a Docker container. For standard Linux App Service, see "Puppeteer Handling" below. |

> **Note**: Azure automatically sets the `PORT` environment variable. The application has been updated to respect this.

## 3. Deployment Source

1.  Go to **Deployment** -> **Deployment Center**.
2.  Select **Source**: GitHub.
3.  Authorize and select your Organization, Repository, and Branch.
4.  Azure will automatically create a Github Action for build and deploy.

## 4. Puppeteer Handling (The Tricky Part)

This application uses Puppeteer (Headless Chrome). On Azure App Service Linux, the default environment might lack necessary shared libraries for Chrome.

### Option A: Use a Startup Command (Easiest for Code Deployment)

Most recent Node.js images on Azure might support it, but often fail. You may need to install dependencies.

However, the **recommended** and most reliable way for Puppeteer on Azure is to use **Docker**, or ensure the environment installs dependencies.

If sticking to **Code Deployment**, add a `spacelift` or custom startup command, or simply try to run it. If it fails with "error loading shared libraries", you have two options:

1.  **Switch to Docker**: Dockerize the app (create a Dockerfile that installs Chrome dependencies) and deploy as a Container.
2.  **Puppeteer Configuration**: Ensure `puppeteer` downloads its cache in a writable location (project folder) properly during build.

### Option B: Docker (Recommended for Stability)

Create a `Dockerfile` in the root:

```dockerfile
FROM node:20-slim

# Install latest chrome dev package and fonts to support major charsets (Chinese, Japanese, Arabic, Hebrew, Thai and a few others)
# Note: this installs the necessary libs to make the bundled version of Chromium that Puppeteer
# installs, work.
RUN apt-get update \
    && apt-get install -y wget gnupg \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/googlechrome-linux-keyring.gpg \
    && sh -c 'echo "deb [arch=amd64 signed-by=/usr/share/keyrings/googlechrome-linux-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable fonts-ipafont-gothic fonts-wqy-zenhei fonts-thai-tlwg fonts-kacst fonts-freefont-ttf libxss1 \
      --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
# Install dependencies
RUN npm ci

COPY . .

# Build the frontend
RUN npm run build

EXPOSE 3000
CMD [ "npm", "run", "start" ]
```

Then change your App Service to "Publish: **Docker Container**".

## 5. Startup Command

If deploying as **Code** (not Docker), verify the startup command in **Settings** -> **General Settings** if the automated detection fails.

Command: `npm run start`
