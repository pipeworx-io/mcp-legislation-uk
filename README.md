# legislation-uk

UK legislation from [legislation.gov.uk](https://www.legislation.gov.uk) — the official database of UK Acts and statutory instruments. Search for legislation, read its metadata, and read the actual text of an Act or of one section, in the version you choose (as amended, as enacted, or as it stood on a date).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

Covers England, Wales, Scotland and Northern Ireland: `ukpga` (UK Public General Acts), `uksi` (UK Statutory Instruments), `asp` (Acts of the Scottish Parliament), `anaw`/`asc` (Wales), `nia` (Northern Ireland Acts), `ukla` (UK Local Acts).

## Tools

| Tool | What it returns |
|------|-----------------|
| `search_legislation` | Search by title words (and optional year) → matching Acts/instruments with full-text URLs |
| `get_legislation` | Metadata for one Act/instrument by type + year + number: title, status, extent, enactment date, full-text URL |
| `get_legislation_section` | The actual text of ONE section — e.g. section 5 of the Data Protection Act 2018 (`ukpga/2018/12`) — without paying for the whole statute |
| `get_legislation_text` | The text of a whole Act/instrument, byte-bounded: large Acts are truncated with an explicit note pointing at the section-level tool |

### Versions (the trap)

UK legislation exists in point-in-time versions that differ in substance, not cosmetics: the text **as enacted** and the text **as amended** at a date. Section 5 of the Data Protection Act 2018 refers to "the GDPR" as enacted and "the UK GDPR" as it stands today. The text tools take a `version` argument — `"current"` (default), `"enacted"`, or a `YYYY-MM-DD` date — and **every response states which version it served** and the date that version took effect. Repealed/omitted words appear as runs of dots, exactly as legislation.gov.uk renders them.

Section numbering also differs between versions: a section inserted by amendment does not exist in the enacted text, so a `section_not_found` for one version may still exist in another.

## Auth

None. legislation.gov.uk is keyless and free.

## Data sources

- [legislation.gov.uk](https://www.legislation.gov.uk) — full text as CLML XML at `/{type}/{year}/{number}/data.xml`, section-level at `/{type}/{year}/{number}/section/{n}/data.xml`, versioned via `/enacted` or `/{date}` path segments; search via the Atom feed at `/{type}/data.feed`.

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

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/legislation-uk/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Legislation Uk data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
