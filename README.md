# Quest Table

A multiplayer, text-based fantasy adventure where Claude is the Game Master.

- Players enter a name and land in a shared **waiting room**.
- The room has a **target party size (1–8)** that any waiting player can change. When the room reaches it, the adventure starts automatically.
- **Any player can press "Stop waiting — begin the adventure"** at any time; everyone currently in the waiting room joins that party. The waiting room then empties and starts filling the next party. Many parties can play at once.
- Each turn, the GM narrates and asks for decisions. Every player declares an action; the turn resolves when everyone has acted (or someone presses **Proceed without waiting**).
- When an outcome is uncertain, the GM calls a `request_rolls` tool. The named players click **Roll**, the **server** rolls the dice (`crypto.randomInt`), and the results go back to Claude, which narrates the consequences. The AI never makes up dice results.
- Table talk (out-of-character chat) is shared with the party but not sent to the GM.
- Refreshing the page reconnects you to your party with the full story so far. If a player is away when a roll is due, the server rolls for them so the table isn't blocked.

## Stack

Node 20+, Express, Socket.IO, `@anthropic-ai/sdk` (Claude Messages API with tool use and streaming). There's no database: all game state lives in server memory.

## Run locally

```bash
npm install
cp .env.example .env              # add your key, or leave it blank for demo mode
ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000 in two or more browser tabs (each tab is a separate player)
```

If `ANTHROPIC_API_KEY` isn't set, the server runs a **mock GM** with canned text, so you can test the multiplayer flow without spending anything. Run `npm test` for the end-to-end multiplayer test, which uses the mock.

## Deploy: GitHub → Railway

1. **GitHub:** create an empty repo, then:
   ```bash
   git remote add origin https://github.com/<you>/quest-table.git
   git push -u origin main
   ```
2. **Railway:** New Project → *Deploy from GitHub repo* → pick the repo. Railway detects Node and runs `npm start`.
3. **Variables** (service → Variables):
   - `ANTHROPIC_API_KEY`: required for the real GM
   - `ANTHROPIC_MODEL`: optional, default `claude-sonnet-5-5`
4. **Networking** → *Generate Domain*. WebSockets work out of the box.
5. Keep the service at **1 replica**. State is in memory, so a second replica would split players across separate lobbies.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API key; blank = mock GM |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | Model used as GM |
| `GM_MAX_TOKENS` | `1200` | Max tokens per GM reply |
| `MAX_PARTIES` | `20` | Concurrent adventures allowed (cost guard) |
| `COMPACT_AFTER_MESSAGES` | `40` | History length that triggers an AI recap of older turns |
| `ABANDON_MINUTES` | `15` | Party is deleted after everyone has been gone this long |

## Known limitations

- **No persistence.** Every redeploy or restart ends all games in progress. Adding Redis or Postgres would fix this.
- **No accounts or auth.** Identity is a random per-tab ID. Anyone with the URL can play and spend your API credits. `MAX_PARTIES` limits concurrent games, but there's no per-user rate limit. Set a spending limit in the Claude Console.
- **One waiting room.** Players can't choose which party to join or create private parties.
- Player text goes straight into the GM prompt. The system prompt tells Claude to treat it as in-character action, which limits but doesn't eliminate prompt manipulation. For a game, that's an acceptable risk.

## Code map

- `server.js`: HTTP and Socket.IO, player registry, waiting room, party creation
- `src/party.js`: turn loop (GM → actions → rolls → GM), dice, reconnects, history compaction
- `src/gm.js`: Claude system prompt, tool definitions, streaming call, mock GM
- `public/`: browser client (vanilla JS)
- `test/e2e.js`: simulated multiplayer test
