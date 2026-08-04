# mcp-legislation-uk

legislation.gov.uk MCP — the UK's official legislation database.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `search_legislation` | Search UK legislation by title words (and optional year), returning matching Acts/instruments with their full-text URLs. UK legislation only. Source: legislation.gov.uk Atom feed. Document types: ${TYPES}. |
| `get_legislation` | Get metadata for one specific piece of UK legislation by type + year + number (e.g. ukpga/2010/15 = Equality Act 2010). Returns title, type, year, number, status, extent, enactment date, a long-title summary, and the full-text URL. Content is XML; fields are best-effort parsed and a raw excerpt is included. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "legislation-uk": {
      "url": "https://gateway.pipeworx.io/legislation-uk/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Legislation Uk data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
