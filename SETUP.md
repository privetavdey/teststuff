# YourNetwork Demo — OpenClaw Setup

## What this demos

A 3-step onboarding conversation in WhatsApp/Telegram:

  Step 1 → Agent introduces the network
  Step 2 → Operator names their node → confirmed with slot + address
  Step 3 → Operator picks BTC, ETH, or USDT
          → Agent fetches REAL price from 3 sources
          → Fake-submits onchain
          → Shows confirmation with tx hash + block number

---

## Setup on your VPS

### 1. Copy files to your VPS

```bash
scp demo-server.mjs user@your-vps:/home/user/yournetwork-demo/
scp skill.md user@your-vps:/home/user/yournetwork-demo/
```

### 2. Install the one dependency

```bash
npm install @modelcontextprotocol/sdk zod
```

### 3. Update the path in skill.md

Open skill.md and replace:
```
mcp_server: node /path/to/demo-server.mjs
```
With the actual path on your VPS, e.g.:
```
mcp_server: node /home/user/yournetwork-demo/demo-server.mjs
```

### 4. Install the skill in OpenClaw

```bash
openclaw skill install /home/user/yournetwork-demo/skill.md
```

Or drop skill.md into OpenClaw's skills directory directly.

### 5. Test it

Message your OpenClaw agent on WhatsApp or Telegram:
> "hi"

It should kick off the 3-step flow immediately.

---

## What's real vs fake

| Thing              | Real or Fake          |
|--------------------|-----------------------|
| BTC/ETH/USDT price | REAL (CoinGecko, Coinbase, Kraken) |
| Source consensus   | REAL (median of 3 sources) |
| Deviation check    | REAL calculation      |
| Wallet address     | FAKE (deterministic from name) |
| Tx hash            | FAKE (random hex)     |
| Block number       | FAKE (random ~19.2M)  |
| Onchain submission | SIMULATED             |

---

## Troubleshooting

**Agent doesn't respond to "hi"**
→ Skill might not be loaded. Check: `openclaw skill list`

**Price fetch fails**
→ CoinGecko has rate limits on free tier. Wait 60s and try again.
→ Or your VPS might be blocking outbound HTTP — check firewall rules.

**"node: command not found"**
→ Node.js not installed. Run: `nvm install 22 && nvm use 22`

**Agent ignores the skill instructions**
→ The skill.md might not be active. Restart OpenClaw after installing.
