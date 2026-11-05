# 10kobo MCP server

Lets Claude and other MCP clients pay Nigerian bank accounts in naira through 10kobo. It holds no wallet and no money:
it arranges the payment, and the agent's own wallet sends the USDC.

| Tool | What it does |
| --- | --- |
| `quote_naira_payment` | Prices a payment and shows the bank's name for the account. Moves nothing |
| `accept_quote` | Gives the exact USDC and the one-time address. Moves nothing |
| `check_payment` | Reports progress, and the receipt once paid |

## Try it

1. Run `npm install` in this folder.
2. Add it to your MCP client, for example:

```json
{ "mcpServers": { "10kobo": { "command": "node", "args": ["/path/to/mcp-server/src/main.ts"], "env": { "TENKOBO_API_URL": "http://localhost:4010" } } } }
```

3. Ask: "How much USDC to pay ₦1,400 to OPay 8031234568?"

`TENKOBO_API_KEY` is optional. Without one, limits for paying with no key apply. Against a backend in test mode, no real money moves.
