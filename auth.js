services:
  - type: web
    name: parkking-os
    runtime: docker
    plan: free
    disk:
      name: parkking-data
      mountPath: /app/data
      sizeGB: 1
    envVars:
      - key: PK_URL
        sync: false
      - key: PK_EMAIL
        sync: false
      - key: PK_PASSWORD
        sync: false
      - key: PSF_URL
        sync: false
      - key: PSF_EMAIL
        sync: false
      - key: PSF_PASSWORD
        sync: false
      - key: JWT_SECRET
        generateValue: true
      - key: APP_PASSWORD
        sync: false
      - key: PUPPETEER_SKIP_CHROMIUM_DOWNLOAD
        value: "true"
      - key: PUPPETEER_EXECUTABLE_PATH
        value: "/usr/bin/chromium"
      - key: NODE_ENV
        value: production
