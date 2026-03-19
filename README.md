# IPL Auction Platform

Real-time multiplayer IPL-style cricket auction platform built with React, Vite, Express, and Socket.IO.

## Local development

```powershell
npm install
npm run dev
```

URLs:

- Frontend: `http://localhost:5173`
- Backend health: `http://localhost:4000/health`

## Production

The app is now set up to run as a single public website:

- `npm run build` builds the frontend into `dist/`
- `npm start` runs the Express server
- Express serves the built frontend and the Socket.IO backend from the same origin

## Deploy on Render

This repo includes [render.yaml](/D:/NEW/render.yaml).

Steps:

1. Push this project to GitHub.
2. Create a new Render Blueprint or Web Service from that repo.
3. Render will use:
   - Build command: `npm install && npm run build`
   - Start command: `npm start`
4. After deploy, share the Render URL. Everyone can access the site from that single public link.

## Core features

- Room-code based multiplayer auction
- Live synchronized bidding with Socket.IO
- Anti-sniping timer extensions
- Admin controls for start, pause, resume, and skip
- Budget analytics and team squads
- AI-style player suggestions based on roster balance
