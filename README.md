# MUSH Client

A web-based MUSH/MUD/MUCK client that runs in your browser. Connect to multiple worlds simultaneously in separate tabs, manage characters with saved credentials, and log sessions — all from a clean terminal interface.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/DEOujn?referralCode=DkzoI9&utm_medium=integration&utm_source=template&utm_campaign=generic)

## Features

- Connect to multiple worlds in tabs simultaneously
- Character management with encrypted password storage
- Session logging (ANSI stripped, plain text)
- Browse the mushcode.com MUSH list and add worlds directly
- Export/import your world list as JSON
- Password protection for your instance
- Flashing favicon when a message arrives in a background tab

## Deploy to Railway

1. Click the button above and set `APP_PASSWORD` to protect your instance
2. Once deployed, go to your service → **Volumes** → **Add Volume**, mount path: `/app/data` — this persists your worlds, characters, and logs across deploys. Without it everything resets on redeploy.
3. If adding a custom domain, set the port to `8080`

## Run Locally

```bash
npm install
node server.js
```

Open http://localhost:3000

## Docker

```bash
docker compose up
```

## Environment Variables

| Variable | Description |
|---|---|
| `APP_PASSWORD` | Password to protect your instance (leave unset for open access) |
| `PORT` | Port to listen on (default: 3000) |
