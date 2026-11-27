# Felt — No-Limit Texas Hold'em

An iOS-style poker game that runs in any browser (desktop, tablet, phone) and installs as an app via "Add to Home Screen". Pure static files, so it deploys on Vercel with no build step and no server.

## Features
- **No-Limit Texas Hold'em** with correct rules: blinds, heads-up button rules, min-raise, incomplete all-in raises, side pots, split pots with odd-chip rule, uncalled bets returned
- **2–10 seats**, chosen by the host
- **Play vs Bots**: bots use Monte Carlo equity and each one has its own play style
- **Online tables**: the host gets a 5-letter code and an invite link, friends join from any device, you can mix humans and bots, and spectators can watch
- Turn timer with auto check/fold. Players who time out twice are sat out
- Reconnects automatically if a phone sleeps or the network drops
- **Chip betting**: tap chips (hold to repeat) to build your raise, tap a stack to take a chip back, or use Min / ½ Pot / ¾ Pot / Pot / All-in. Chips fly to the table and into the pot, and pots are paid out to the winner
- **Chips on the felt**: every player's stack, bets in front of players and the pot are drawn as chip piles
- **Dealing animation**: a deck sits next to the dealer button and each card flies out to every seat in turn
- **Odds helper**: live win %, pot odds, outs, how your hand is likely to finish, and a 52-card deck tracker (the host can turn it off per table)
- **Game length**: endless, or 10 / 20 / 50 hands with a winner screen and rematch
- Pre-actions (Check/Fold, Call Any)
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
js/odds.js            Win %, outs and hand-finish odds for the helper
js/net.js             Host/guest networking (PeerJS)
js/app.js             UI controller and rendering
js/sound.js           Synthesized sound effects (no audio files)
config.js             Optional TURN / signaling settings
vendor/peerjs.min.js  PeerJS 1.5.4 (bundled, no CDN needed)
fonts/                Roboto (bundled)
sw.js, manifest.webmanifest, icons/   PWA install + offline
```

When you ship an update, bump `VERSION` in `sw.js` so installed copies refresh.

## Wi-Fi mode (no internet needed)

**Phones only? Host from an Android phone with Termux** (free, from F-Droid): run `pkg install nodejs git`, copy this folder onto the phone (or `git clone` once while online), then `cd poker && node lan-server.js`. Turn on that phone's hotspot (no data needed) or use shared Wi-Fi; everyone else — Android or iPhone — just opens the address in a browser. An iPhone can join but can't be the server.

Play with friends on the same Wi-Fi (or a phone/laptop hotspot) with no internet at all.

1. On **one** computer with [Node.js](https://nodejs.org) installed, double-click `Start Wi-Fi Game.bat` (Windows) / `Start Wi-Fi Game.command` (Mac), or run `npm start`.
2. Open `http://localhost:3000` on that computer, tap **Host a Table**, and share the QR code.
3. Friends open the address shown (or scan the QR) and tap **Join with Code** → pick the table from "Tables on this Wi-Fi".

The app detects the server automatically and shows a green "Wi-Fi mode" badge. Notes:
- Allow Node through the firewall when prompted (private networks only).
- Hostel/public Wi-Fi often blocks device-to-device traffic ("client isolation"). Use a hotspot instead — it works without mobile data.
- Over plain `http` there is no install prompt, wake-lock or clipboard on some phones; the game itself is unaffected.
