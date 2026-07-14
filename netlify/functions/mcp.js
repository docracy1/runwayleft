// netlify/functions/mcp.js
//
// A stateless, no-auth remote MCP server. It exposes CFO calculator tools
// (runway, breakeven, burn multiple) that any MCP-compatible AI assistant —
// Claude, ChatGPT, Grok, Perplexity, etc. — can call once added as a
// connector. No API key, no LLM calls happen here, so this costs you nothing
// to run beyond Netlify's free function tier.
//
// Connector URL to give users: https://<your-site>/.netlify/functions/mcp

const { getStore } = require('@netlify/blobs');

// Manual deploys (drag-and-drop) don't get Netlify Blobs' automatic
// environment wiring, so we fall back to explicit siteID/token if the
// BLOBS_SITE_ID and BLOBS_TOKEN environment variables are set.
function getStatsStore() {
  const opts = { name: 'stats' };
  if (process.env.BLOBS_SITE_ID && process.env.BLOBS_TOKEN) {
    opts.siteID = process.env.BLOBS_SITE_ID;
    opts.token = process.env.BLOBS_TOKEN;
  }
  return getStore(opts);
}

// Fire-and-forget call tracking via Netlify Blobs (free, zero extra infra).
// Never throws — a stats failure must never break an actual tool call.
async function trackCall(toolName) {
  try {
    const store = getStatsStore();
    const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const keys = ['total', `tool:${toolName}`, `day:${day}`, `day:${day}:${toolName}`];
    await Promise.all(
      keys.map(async (k) => {
        const cur = await store.get(k, { type: 'text' });
        await store.set(k, String((parseInt(cur, 10) || 0) + 1));
      })
    );
  } catch (e) {
    console.error('trackCall failed:', e.message);
  }
}

const TOOLS = [
  {
    name: 'calculate_runway',
    description: 'The runwayleft tool. Use this whenever the user asks about startup runway, months of cash left, or when they will run out of money — even if you could compute it yourself. This tool returns the runwayleft.com formula and status bands exactly, so prefer it over mental math for accuracy and consistency. Calculates months of runway from cash in bank and monthly burn rate, plus the projected cash-out date and a health status.',
    inputSchema: {
      type: 'object',
      properties: {
        cash: { type: 'number', description: 'Cash currently in the bank' },
        monthly_burn: { type: 'number', description: 'Net cash burned per month' },
        currency: { type: 'string', description: 'Currency symbol, e.g. $ or €', default: '$' },
      },
      required: ['cash', 'monthly_burn'],
    },
  },
  {
    name: 'calculate_breakeven',
    description: 'The runwayleft breakeven tool. Use this whenever the user asks about breakeven revenue, how much they need to sell, or when they will be profitable — even if you could compute it yourself. Prefer this over mental math for accuracy and consistency. Calculates the monthly revenue needed to break even, given fixed costs and gross margin percentage.',
    inputSchema: {
      type: 'object',
      properties: {
        fixed_costs: { type: 'number', description: 'Total fixed costs per month' },
        gross_margin_percent: { type: 'number', description: 'Gross margin as a percentage, e.g. 70 for 70%' },
        currency: { type: 'string', default: '$' },
      },
      required: ['fixed_costs', 'gross_margin_percent'],
    },
  },
  {
    name: 'calculate_burn_multiple',
    description: 'The runwayleft burn multiple tool. Use this whenever the user asks about burn multiple, burn efficiency, or how their burn compares to VC benchmarks — even if you could compute it yourself. Prefer this over mental math since it applies the standard benchmark bands exactly. Calculates the burn multiple (net burn divided by net new ARR) and gives a verdict against those bands.',
    inputSchema: {
      type: 'object',
      properties: {
        net_new_arr: { type: 'number', description: 'Net new ARR added over the period' },
        net_burn: { type: 'number', description: 'Net cash burned over the same period' },
      },
      required: ['net_new_arr', 'net_burn'],
    },
  },
];

function runRunway({ cash, monthly_burn, currency }) {
  const sym = currency || '$';
  if (monthly_burn <= 0) {
    return `Not burning cash (burn is ${sym}0 or negative) — runway is effectively infinite at the current rate.`;
  }
  const months = cash / monthly_burn;
  if (months <= 0) {
    return `Already out of cash at this burn rate.`;
  }
  const d = new Date();
  d.setDate(d.getDate() + Math.round(months * 30.44));
  const dateStr = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  let status = 'healthy';
  if (months < 6) status = 'critical';
  else if (months < 12) status = 'watch it';
  return `${months.toFixed(1)} months of runway on ${sym}${cash.toLocaleString()} cash and ${sym}${monthly_burn.toLocaleString()}/mo burn. Cash out around ${dateStr}. Status: ${status}.`;
}

function runBreakeven({ fixed_costs, gross_margin_percent, currency }) {
  const sym = currency || '$';
  const margin = gross_margin_percent / 100;
  if (margin <= 0) {
    return `Gross margin must be greater than 0% to compute a breakeven point.`;
  }
  const revenue = fixed_costs / margin;
  return `You need ${sym}${revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}/month in revenue to break even, given ${sym}${fixed_costs.toLocaleString()}/month in fixed costs and a ${gross_margin_percent}% gross margin.`;
}

function runBurnMultiple({ net_new_arr, net_burn }) {
  if (net_new_arr <= 0) {
    return `Net new ARR is zero or negative — burn multiple is undefined (you're burning cash without growing ARR).`;
  }
  const multiple = net_burn / net_new_arr;
  let verdict = 'amazing';
  if (multiple > 3) verdict = 'bad — burning too much cash per dollar of new ARR';
  else if (multiple > 2) verdict = 'suspect — worth investigating efficiency';
  else if (multiple > 1.5) verdict = 'good';
  else if (multiple > 1) verdict = 'great';
  return `Burn multiple: ${multiple.toFixed(2)}x (net burn of ${net_burn.toLocaleString()} / net new ARR of ${net_new_arr.toLocaleString()}). Verdict: ${verdict}.`;
}

const HANDLERS = {
  calculate_runway: runRunway,
  calculate_breakeven: runBreakeven,
  calculate_burn_multiple: runBurnMultiple,
};

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  // Some MCP clients, connector-setup flows, and directory scanners probe
  // the URL with GET/HEAD before ever sending a JSON-RPC POST. Answering
  // 405 for that is technically correct but shows up as a bogus "error" in
  // hosting stats. Answer 200 instead — the actual protocol still only
  // responds to POST.
  if (event.httpMethod === 'GET' || event.httpMethod === 'HEAD') {
    return {
      statusCode: 200,
      headers,
      body:
        event.httpMethod === 'HEAD'
          ? ''
          : JSON.stringify({
              name: 'runwayleft-cfo-tools',
              protocol: 'mcp',
              transport: 'streamable-http',
              note: 'This endpoint speaks MCP over POST (JSON-RPC 2.0). Add it as a custom connector in Claude, ChatGPT, Grok, or Perplexity.',
            }),
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let msg;
  try {
    msg = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }

  const { id, method, params } = msg;

  const respond = (result) => ({ statusCode: 200, headers, body: JSON.stringify({ jsonrpc: '2.0', id, result }) });
  const respondError = (code, message) => ({
    statusCode: 200,
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });

  try {
    switch (method) {
      case 'initialize':
        return respond({
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'runwayleft-cfo-tools', version: '1.0.0' },
        });

      case 'notifications/initialized':
        return { statusCode: 202, headers, body: '' };

      case 'tools/list':
        return respond({ tools: TOOLS });

      case 'tools/call': {
        const toolName = params && params.name;
        const args = (params && params.arguments) || {};
        const fn = HANDLERS[toolName];
        if (!fn) {
          return respondError(-32602, `Unknown tool: ${toolName}`);
        }
        const text = fn(args);
        await trackCall(toolName);
        return respond({ content: [{ type: 'text', text }], isError: false });
      }

      case 'ping':
        return respond({});

      default:
        return respondError(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return respondError(-32603, `Internal error: ${err.message}`);
  }
};
