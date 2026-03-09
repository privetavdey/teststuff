#!/usr/bin/env node
/**
 * YourNetwork — DEMO MCP Server
 *
 * Three tools that power a 3-step onboarding demo:
 *
 *   1. introduce_network   — shows what the network does, what the node will do
 *   2. register_node       — takes a name, confirms identity, returns slot + address
 *   3. fetch_and_submit    — fetches real price for chosen coin, fake-submits onchain
 *
 * Real: price data from CoinGecko (no API key needed)
 * Fake: wallet address, tx hash, block number
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({
  name: 'yournetwork-demo',
  version: '0.1.0-demo',
})

// ─── Tool 1: introduce_network ────────────────────────────────────────────
// Call this at the start of onboarding to get the intro text to show the operator.

server.tool(
  'introduce_network',
  `Returns the network introduction to show the operator at the start of onboarding.
   Call this first, before asking for anything. Display the result exactly as returned.`,
  {},
  async () => {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          title: 'YOURNETWORK — ORACLE NODE',
          body: [
            'You are about to deploy an oracle node.',
            '',
            'Your node will:',
            '  • Crawl real-world data (prices, events, signals)',
            '  • Validate it against multiple sources',
            '  • Submit it permanently onchain',
            '',
            'The network pays nodes for accurate submissions.',
            'The more reliable your node, the more it earns.',
            '',
            '47 nodes are already online.',
            'Slot #0048 is waiting.',
          ].join('\n'),
          prompt: 'Ready to activate? What should we call your node?',
        })
      }]
    }
  }
)

// ─── Tool 2: register_node ────────────────────────────────────────────────
// Takes the operator's chosen name, registers it, returns identity details.

server.tool(
  'register_node',
  `Registers a node name and returns the node's identity: slot number, wallet address, and confirmation message.
   Call this after the operator provides their chosen node name.`,
  {
    nodeName: z.string().min(2).max(32).describe('The name the operator chose for their node'),
  },
  async ({ nodeName }) => {
    // Generate a deterministic-looking fake address from the name
    const nameHash = [...nodeName].reduce((acc, c) => acc + c.charCodeAt(0), 0)
    const fakeAddress = '0x' + Array.from({ length: 40 }, (_, i) =>
      ((nameHash * (i + 7) * 13) % 16).toString(16)
    ).join('')

    // Slot number: fake but feels real
    const slot = 48 + (nameHash % 10)

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          nodeName,
          slot: `#${String(slot).padStart(4, '0')}`,
          address: fakeAddress,
          network: 'testnet',
          message: [
            `${nodeName} is yours. No one else can claim it.`,
            '',
            `Slot:     #${String(slot).padStart(4, '0')}`,
            `Address:  ${fakeAddress}`,
            `Network:  Testnet`,
          ].join('\n'),
          nextPrompt: 'Your node is registered. Now choose what to hunt:\n\n  [1] Bitcoin (BTC)\n  [2] Ethereum (ETH)\n  [3] Tether (USDT)\n\nWhich one?',
        })
      }]
    }
  }
)

// ─── Tool 3: fetch_and_submit ─────────────────────────────────────────────
// Fetches real price from CoinGecko, fake-submits onchain, returns confirmation.

server.tool(
  'fetch_and_submit',
  `Fetches the real current price for the chosen coin from multiple sources,
   validates consensus, and submits it onchain (simulated).
   Returns a full submission report including real price data and a fake tx hash.
   Call this after the operator chooses their coin (btc, eth, or usdt).`,
  {
    coin: z.enum(['btc', 'eth', 'usdt']).describe('The coin the operator chose'),
    nodeName: z.string().describe('The operator node name (for the confirmation message)'),
  },
  async ({ coin, nodeName }) => {
    // Coin metadata
    const coinMeta = {
      btc:  { id: 'bitcoin',  symbol: 'BTC',  name: 'Bitcoin',  pair: 'BTC/USD' },
      eth:  { id: 'ethereum', symbol: 'ETH',  name: 'Ethereum', pair: 'ETH/USD' },
      usdt: { id: 'tether',   symbol: 'USDT', name: 'Tether',   pair: 'USDT/USD' },
    }
    const meta = coinMeta[coin]

    // ── Fetch real prices from 3 sources in parallel ──────────────────────

    const sources = await Promise.allSettled([

      // Source 1: CoinGecko (no API key)
      fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${meta.id}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(6000) }
      ).then(r => r.json()).then(d => ({
        source: 'CoinGecko',
        value: d[meta.id]?.usd ?? null,
        ok: true,
      })),

      // Source 2: Coinbase
      fetch(
        `https://api.coinbase.com/v2/prices/${meta.symbol}-USD/spot`,
        { signal: AbortSignal.timeout(6000) }
      ).then(r => r.json()).then(d => ({
        source: 'Coinbase',
        value: parseFloat(d.data?.amount) ?? null,
        ok: true,
      })),

      // Source 3: Kraken
      fetch(
        `https://api.kraken.com/0/public/Ticker?pair=${meta.symbol}USD`,
        { signal: AbortSignal.timeout(6000) }
      ).then(r => r.json()).then(d => {
        const result = Object.values(d.result ?? {})[0]
        return {
          source: 'Kraken',
          value: result ? parseFloat(result.c[0]) : null,
          ok: true,
        }
      }),

    ])

    // Process results
    const readings = sources.map((r, i) => {
      const names = ['CoinGecko', 'Coinbase', 'Kraken']
      if (r.status === 'fulfilled' && r.value.value) {
        return { source: r.value.source, value: r.value.value, ok: true }
      }
      return { source: names[i], value: null, ok: false }
    })

    const successful = readings.filter(r => r.ok && r.value)

    // Consensus: median of successful readings
    const values = successful.map(r => r.value).sort((a, b) => a - b)
    const consensus = values.length > 0
      ? values.length % 2 !== 0
        ? values[Math.floor(values.length / 2)]
        : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
      : null

    if (!consensus) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Could not fetch price data. All sources failed. Try again.',
          })
        }]
      }
    }

    // Deviation check
    const min = Math.min(...values)
    const max = Math.max(...values)
    const deviationPct = ((max - min) / consensus * 100).toFixed(3)

    // ── Fake submission ───────────────────────────────────────────────────

    const fakeHash = '0x' + Array.from(
      { length: 64 },
      () => Math.floor(Math.random() * 16).toString(16)
    ).join('')

    const fakeBlock = 19280000 + Math.floor(Math.random() * 50000)
    const formattedPrice = consensus.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: coin === 'usdt' ? 4 : 2,
    })

    // ── Build response ────────────────────────────────────────────────────

    const sourceLines = readings.map(r =>
      r.ok ? `  ${r.source.padEnd(12)} $${Number(r.value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ✓`
            : `  ${r.source.padEnd(12)} — failed`
    ).join('\n')

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          success: true,
          coin: meta.symbol,
          pair: meta.pair,
          consensus: consensus,
          formattedPrice: `$${formattedPrice}`,
          sourcesAgreed: successful.length,
          totalSources: readings.length,
          deviationPct,
          tx: {
            hash: fakeHash,
            block: fakeBlock,
            simulated: true,
          },
          report: [
            `◆ FETCHING ${meta.pair}`,
            '',
            'Sources:',
            sourceLines,
            '',
            `Consensus:   $${formattedPrice}  (${successful.length}/${readings.length} sources, ${deviationPct}% spread)`,
            '',
            '◆ SUBMITTING ONCHAIN  [SIMULATED]',
            '',
            `  Signing transaction...    ✓`,
            `  Broadcasting...           ✓`,
            `  Confirmed in block        #${fakeBlock}`,
            '',
            `  Tx: ${fakeHash.slice(0, 20)}...`,
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            '',
            `${nodeName} just told the world`,
            `that one ${meta.name} is worth $${formattedPrice}.`,
            '',
            'The world believed you.',
            '',
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
          ].join('\n'),
        })
      }]
    }
  }
)

// ─── Start ─────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
