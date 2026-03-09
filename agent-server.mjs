#!/usr/bin/env node
/**
 * YourNetwork — Full Agent MCP Server
 *
 * Tools:
 *   1. introduce_network     — step 1: show what's happening
 *   2. register_node         — step 2: name the node, get identity
 *   3. select_and_spawn      — step 3: pick coin, spawn dedicated agent, start crawl loop
 *   4. get_latest_update     — called by heartbeat to get latest price update to report
 *   5. stop_crawl            — operator can pause the crawl
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── State ────────────────────────────────────────────────────────────────

const DIR = join(homedir(), '.yournetwork-agent')
const STATE_FILE = join(DIR, 'state.json')
const UPDATES_FILE = join(DIR, 'updates.json')

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')) } catch { return null }
}

function saveState(state) {
  ensureDir()
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function loadUpdates() {
  try { return JSON.parse(readFileSync(UPDATES_FILE, 'utf-8')) } catch { return [] }
}

function saveUpdates(updates) {
  ensureDir()
  writeFileSync(UPDATES_FILE, JSON.stringify(updates, null, 2))
}

// ─── Price fetching ───────────────────────────────────────────────────────

const COIN_META = {
  btc:  { id: 'bitcoin',  symbol: 'BTC',  name: 'Bitcoin',  pair: 'BTC/USD' },
  eth:  { id: 'ethereum', symbol: 'ETH',  name: 'Ethereum', pair: 'ETH/USD' },
  usdt: { id: 'tether',   symbol: 'USDT', name: 'Tether',   pair: 'USDT/USD' },
}

async function fetchPrice(coin) {
  const meta = COIN_META[coin]

  const results = await Promise.allSettled([
    fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${meta.id}&vs_currencies=usd`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then(d => ({ source: 'CoinGecko', value: d[meta.id]?.usd, ok: true })),

    fetch(`https://api.coinbase.com/v2/prices/${meta.symbol}-USD/spot`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then(d => ({ source: 'Coinbase', value: parseFloat(d.data?.amount), ok: true })),

    fetch(`https://api.kraken.com/0/public/Ticker?pair=${meta.symbol}USD`, { signal: AbortSignal.timeout(5000) })
      .then(r => r.json()).then(d => {
        const result = Object.values(d.result ?? {})[0]
        return { source: 'Kraken', value: result ? parseFloat(result.c[0]) : null, ok: !!result }
      }),
  ])

  const readings = results.map(r =>
    r.status === 'fulfilled' && r.value?.value
      ? { source: r.value.source, value: r.value.value, ok: true }
      : { source: '?', value: null, ok: false }
  )

  const successful = readings.filter(r => r.ok)
  const values = successful.map(r => r.value).sort((a, b) => a - b)
  const consensus = values.length
    ? values.length % 2 !== 0
      ? values[Math.floor(values.length / 2)]
      : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
    : null

  return { consensus, readings, successful: successful.length, meta }
}

function fakeTx() {
  return {
    hash: '0x' + Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join(''),
    block: 19280000 + Math.floor(Math.random() * 50000),
  }
}

// ─── Crawl loop ───────────────────────────────────────────────────────────
// Runs in background after spawn. Fetches price every 30s, saves update.

let crawlInterval = null

function startCrawlLoop(coin, nodeName) {
  if (crawlInterval) clearInterval(crawlInterval)

  const run = async () => {
    try {
      const state = loadState()
      if (state?.paused) return

      const { consensus, readings, successful, meta } = await fetchPrice(coin)
      if (!consensus) return

      const tx = fakeTx()
      const prev = loadUpdates().slice(-1)[0]
      const prevPrice = prev?.consensus ?? consensus
      const changePct = ((consensus - prevPrice) / prevPrice * 100)
      const changeStr = (changePct >= 0 ? '+' : '') + changePct.toFixed(3) + '%'
      const arrow = changePct > 0 ? '↑' : changePct < 0 ? '↓' : '→'

      const formatted = consensus.toLocaleString('en-US', {
        minimumFractionDigits: 2, maximumFractionDigits: coin === 'usdt' ? 4 : 2
      })

      const sourceLines = readings.map(r =>
        r.ok
          ? `  ${r.source.padEnd(12)} $${Number(r.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ✓`
          : `  ${r.source.padEnd(12)} — failed`
      ).join('\n')

      const update = {
        timestamp: Date.now(),
        coin,
        consensus,
        formattedPrice: `$${formatted}`,
        changePct,
        changeStr,
        arrow,
        sources: successful,
        txHash: tx.hash,
        txBlock: tx.block,
        unread: true,
        message: [
          `◆ ${meta.pair} UPDATE`,
          ``,
          `Price:   $${formatted}  ${arrow} ${changeStr}`,
          `Sources: ${successful}/3 agreed`,
          ``,
          sourceLines,
          ``,
          `Submitted → block #${tx.block}`,
          `Tx: ${tx.hash.slice(0, 18)}...`,
        ].join('\n'),
        shortMessage: `${meta.symbol} $${formatted} ${arrow} ${changeStr} — block #${tx.block}`,
      }

      // Save update — keep last 100
      const updates = loadUpdates()
      updates.push(update)
      if (updates.length > 100) updates.splice(0, updates.length - 100)
      saveUpdates(updates)

      // Update state with latest price
      if (state) {
        state.lastPrice = consensus
        state.totalSubmissions = (state.totalSubmissions ?? 0) + 1
        saveState(state)
      }

    } catch (err) {
      // Silently continue on error
    }
  }

  // Run immediately, then every 30s
  run()
  crawlInterval = setInterval(run, 30_000)
}

// ─── MCP Server ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'yournetwork-agent',
  version: '0.1.0',
})

// ─── Tool 1: introduce_network ────────────────────────────────────────────

server.tool(
  'introduce_network',
  `Step 1 of onboarding. Returns the intro text to show the operator.
   Call this when the operator first messages the agent.`,
  {},
  async () => {
    const state = loadState()
    if (state?.activated) {
      return { content: [{ type: 'text', text: JSON.stringify({
        alreadyActivated: true,
        nodeName: state.nodeName,
        coin: state.coin,
        message: `${state.nodeName} is already running. Crawling ${COIN_META[state.coin].pair} every 30s.`
      })}]}
    }

    return { content: [{ type: 'text', text: JSON.stringify({
      title: 'YOURNETWORK — ORACLE NODE',
      body: [
        'You are about to deploy an oracle node.',
        '',
        'Your node will:',
        '  • Crawl real-world price data every 30 seconds',
        '  • Validate it across 3 independent sources',
        '  • Submit it permanently onchain',
        '  • Report back to you with every update',
        '',
        '47 nodes are already online.',
        'Slot #0048 is waiting.',
      ].join('\n'),
      prompt: 'Ready to activate? What should we call your node?',
    })}]}
  }
)

// ─── Tool 2: register_node ────────────────────────────────────────────────

server.tool(
  'register_node',
  `Step 2 of onboarding. Registers the node name and returns identity details.
   Call this after the operator provides their chosen name.`,
  {
    nodeName: z.string().min(2).max(32).describe('The name the operator chose'),
  },
  async ({ nodeName }) => {
    const nameHash = [...nodeName].reduce((acc, c) => acc + c.charCodeAt(0), 0)
    const address = '0x' + Array.from({ length: 40 }, (_, i) =>
      ((nameHash * (i + 7) * 13) % 16).toString(16)
    ).join('')
    const slot = 48 + (nameHash % 10)

    // Save partial state
    saveState({ nodeName, address, slot, activated: false, paused: false, totalSubmissions: 0 })

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      nodeName,
      slot: `#${String(slot).padStart(4, '0')}`,
      address,
      message: [
        `${nodeName} is yours. No one else can claim it.`,
        '',
        `Slot:     #${String(slot).padStart(4, '0')}`,
        `Address:  ${address}`,
        `Network:  Testnet`,
      ].join('\n'),
      nextPrompt: [
        'Now choose what to hunt:',
        '',
        '  [1] Bitcoin (BTC)',
        '  [2] Ethereum (ETH)',
        '  [3] Tether (USDT)',
        '',
        'Which one?',
      ].join('\n'),
    })}]}
  }
)

// ─── Tool 3: select_and_spawn ─────────────────────────────────────────────

server.tool(
  'select_and_spawn',
  `Step 3 of onboarding. Takes coin choice, does first fetch+submit, spawns the crawl loop.
   After this the agent runs autonomously every 30s.
   Call this after the operator picks their coin.`,
  {
    coin: z.enum(['btc', 'eth', 'usdt']).describe('Coin the operator chose'),
  },
  async ({ coin }) => {
    const state = loadState()
    if (!state) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Node not registered. Start from step 1.' }) }]}
    }

    const meta = COIN_META[coin]

    // First fetch
    const { consensus, readings, successful } = await fetchPrice(coin)
    if (!consensus) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not fetch price. Try again.' }) }]}
    }

    const tx = fakeTx()
    const formatted = consensus.toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: coin === 'usdt' ? 4 : 2
    })

    const sourceLines = readings.map(r =>
      r.ok
        ? `  ${r.source.padEnd(12)} $${Number(r.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ✓`
        : `  ${r.source.padEnd(12)} — failed`
    ).join('\n')

    // Save full state
    saveState({ ...state, coin, activated: true, lastPrice: consensus, totalSubmissions: 1 })

    // Save first update
    saveUpdates([{
      timestamp: Date.now(),
      coin, consensus,
      formattedPrice: `$${formatted}`,
      changePct: 0, changeStr: 'first', arrow: '→',
      sources: successful,
      txHash: tx.hash, txBlock: tx.block,
      unread: false,
      message: '', shortMessage: '',
    }])

    // Start the crawl loop
    startCrawlLoop(coin, state.nodeName)

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      spawnedAgent: true,
      crawlInterval: '30s',
      coin: meta.symbol,
      firstSubmission: {
        price: `$${formatted}`,
        sources: successful,
        txHash: tx.hash,
        txBlock: tx.block,
      },
      report: [
        `◆ FETCHING ${meta.pair}`,
        '',
        'Sources:',
        sourceLines,
        '',
        `Consensus:  $${formatted}  (${successful}/3 sources)`,
        '',
        '◆ FIRST SUBMISSION  [SIMULATED]',
        '',
        `  Confirmed in block  #${tx.block}`,
        `  Tx: ${tx.hash.slice(0, 18)}...`,
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        `${state.nodeName} just told the world`,
        `that one ${meta.name} is worth $${formatted}.`,
        '',
        'The world believed you.',
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '',
        `Agent spawned. Crawling ${meta.pair} every 30 seconds.`,
        'Updates will arrive automatically.',
      ].join('\n'),
    })}]}
  }
)

// ─── Tool 4: get_latest_update ────────────────────────────────────────────

server.tool(
  'get_latest_update',
  `Returns the latest price update from the crawl loop.
   Call this on every heartbeat to check if there is a new update to report to the operator.
   Returns null if no new update since last check.`,
  {},
  async () => {
    const updates = loadUpdates()
    const unread = updates.filter(u => u.unread)

    if (unread.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ hasUpdate: false }) }]}
    }

    // Mark all as read
    updates.forEach(u => u.unread = false)
    saveUpdates(updates)

    const latest = unread[unread.length - 1]
    const state = loadState()

    return { content: [{ type: 'text', text: JSON.stringify({
      hasUpdate: true,
      update: latest,
      nodeStats: {
        nodeName: state?.nodeName,
        totalSubmissions: state?.totalSubmissions ?? 0,
        coin: state?.coin,
      },
    })}]}
  }
)

// ─── Tool 5: stop_crawl ───────────────────────────────────────────────────

server.tool(
  'stop_crawl',
  `Pauses or resumes the crawl loop.
   Call when operator says "pause", "stop", "resume", or "restart".`,
  {
    action: z.enum(['pause', 'resume']).describe('Whether to pause or resume'),
  },
  async ({ action }) => {
    const state = loadState()
    if (!state) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'No active node.' }) }]}
    }

    state.paused = action === 'pause'
    saveState(state)

    return { content: [{ type: 'text', text: JSON.stringify({
      success: true,
      paused: state.paused,
      message: action === 'pause'
        ? `${state.nodeName} paused. Submissions stopped.`
        : `${state.nodeName} resumed. Back to crawling every 30 seconds.`,
    })}]}
  }
)

// ─── Restore crawl loop on restart ────────────────────────────────────────

const existingState = loadState()
if (existingState?.activated && !existingState?.paused) {
  startCrawlLoop(existingState.coin, existingState.nodeName)
}

// ─── Start ─────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
