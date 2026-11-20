# Felt — No-Limit Texas Hold'em

An iOS-style poker game that runs in any browser (desktop, tablet, phone) and installs as an app via "Add to Home Screen". Pure static files, so it deploys on Vercel with no build step and no server.

## Features
- **No-Limit Texas Hold'em** with correct rules: blinds, heads-up button rules, min-raise, incomplete all-in raises, side pots, split pots with odd-chip rule, uncalled bets returned
- **2–10 seats**, chosen by the host
- **Play vs Bots**: bots use Monte Carlo equity and each one has its own play style
- **Online tables**: the host gets a 5-letter code and an invite link, friends join from any device, you can mix humans and bots, and spectators can watch
- Turn timer with auto check/fold. Players who time out twice are sat out
- Reconnects automatically if a phone sleeps or the network drops
- Raise slider with Min / ½ Pot / ¾ Pot / Pot / All-in presets, plus pre-actions (Check/Fold, Call Any)
- Showdown highlights the winning five cards and shows each hand's name
- Chat, hand history, hand-rankings screen, sounds, screen wake lock
- Rebuys on/off and optional blind increases (every 10 or 20 hands)
- Desktop keyboard shortcuts: `F` fold, `C` check/call, `R` raise (press again to confirm), `Esc` cancel
- Installable PWA with offline support for bot games

## Deploy to Vercel
**Option A: GitHub (recommended)**
1. Push this folder to a GitHub repo.
2. In Vercel: **Add New → Project →** import the repo.
3. Framework Preset: **Other**. Leave Build Command and Output Directory empty. Deploy.

**Option B: CLI**
```bash
npm i -g vercel
cd felt-poker
vercel --prod
```

## Run locally
Browsers block ES modules on `file://`, so serve the folder:
```bash
npx serve .        # or: python3 -m http.server 8080
```

## How online play works
The host's browser is the game server. It deals the cards, enforces the rules and sends each player only what they're allowed to see; your hole cards never reach other devices. Players connect peer-to-peer over WebRTC using PeerJS and its free public signaling server, so Vercel only has to serve static files.

Things to know:
- **The host must keep the app open.** If the host closes the tab or locks the phone for a long time, the table ends. A laptop or a plugged-in phone makes the best host.
- Players who drop out keep their seat for 90 seconds and reconnect automatically.
- On some strict mobile or corporate networks a direct peer connection can fail. If a friend can't join, add a TURN server in `config.js` (Metered, Twilio and Cloudflare all offer one).

## Project layout
```
index.html            App shell and screens
css/style.css         iOS design system: grouped lists, sheets, switches, glass
js/engine.js          Authoritative Hold'em engine (pots, betting, timers)
js/cards.js           Deck, 7-card hand evaluator, hand names
js/bot.js             Bot AI (Monte Carlo equity)
js/net.js             Host/guest networking (PeerJS)
js/app.js             UI controller and rendering
js/sound.js           Synthesized sound effects (no audio files)
config.js             Optional TURN / signaling settings
vendor/peerjs.min.js  PeerJS 1.5.4 (bundled, no CDN needed)
sw.js, manifest.webmanifest, icons/   PWA install + offline
```

When you ship an update, bump `VERSION` in `sw.js` so installed copies refresh.
