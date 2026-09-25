# legislation-uk

UK legislation from [legislation.gov.uk](https://www.legislation.gov.uk) — the official database of UK Acts and statutory instruments. Search for legislation, read its metadata, read the actual text of an Act or of one section in the version you choose (as amended, as enacted, or as it stood on a date), see what has amended it (or what it amends), and read the plain-language Explanatory Notes.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

Covers England, Wales, Scotland and Northern Ireland: `ukpga` (UK Public General Acts), `uksi` (UK Statutory Instruments), `asp` (Acts of the Scottish Parliament), `anaw`/`asc` (Wales), `nia` (Northern Ireland Acts), `ukla` (UK Local Acts).

## Tools

| Tool | What it returns |
|------|-----------------|
| `search_uk_legislation` | Search by title words (and optional year) → matching Acts/instruments with full-text URLs. `type` is optional — an exact code, a plain category (`"act"`, `"si"`, `"ssi"`), or omit it to default to `ukpga`. (Renamed from `search_legislation` — the old name still resolves.) |
| `get_legislation` | Metadata for one Act/instrument by type + year + number: title, status, extent, enactment date, full-text URL |
| `get_legislation_section` | The actual text of ONE section — e.g. section 5 of the Data Protection Act 2018 (`ukpga/2018/12`) — without paying for the whole statute. Takes `as_at` (or `version`) for a point-in-time date. |
| `get_legislation_text` | The text of a whole Act/instrument, byte-bounded: large Acts are truncated with an explicit note pointing at the section-level tool. Takes `as_at` (or `version`). |
| `legislation_amendments` | What has amended this legislation (`direction: "affected"`, default) or what it amends (`direction: "affecting"`) — amending/amended instrument, affected/affecting provisions, change type, whether applied, commencement date. **Paged at 50** — always states `total_results`/`total_pages`. |
| `get_explanatory_notes` | Plain-language commentary written by the responsible government department, explaining what a section is meant to do. NOT part of the law. Pass `section` for one section's commentary, or omit for an overview + table of contents. |

### Versions (the trap)

UK legislation exists in point-in-time versions that differ in substance, not cosmetics: the text **as enacted** and the text **as amended** at a date. Section 5 of the Data Protection Act 2018 refers to "the GDPR" as enacted and "the UK GDPR" as it stands today. The text tools take a `version` argument — `"current"` (default), `"enacted"`, or a `YYYY-MM-DD` date — or the equivalent `as_at: "YYYY-MM-DD"` alias, and **every response states which version it served** (`version_valid_from`) and the date that version took effect. Repealed/omitted words appear as runs of dots, exactly as legislation.gov.uk renders them.

Section numbering also differs between versions: a section inserted by amendment does not exist in the enacted text, so a `section_not_found` for one version may still exist in another.

**legislation.gov.uk serves the nearest EARLIER version silently** when nothing changed on the exact date you asked for — the URL and `Content-Location` header both echo the date you requested even though the served text is older. The only place the real served date shows up is the document's own version metadata, which is why `version_valid_from` is on every response and a `version_note` explains the gap whenever `as_at` and `version_valid_from` differ.

### Amendments are paged at 50, never the total

`legislation_amendments` hits `/changes/{affected|affecting}/{type}/{year}/{number}/data.feed`, an Atom feed capped at 50 entries per page. The Data Protection Act 2018 alone has 2,271+ recorded effects across 46 pages — every response carries `total_results`, `total_pages`, `page`, and `next_page` so a caller never mistakes one page for the whole change history.

### Explanatory Notes have no XML — and no single page shape

`data.xml` 404s for `/notes`; only HTML exists, and legislation.gov.uk uses two different templates depending on the Act's age. Older Acts (e.g. Equality Act 2010) put the entire commentary — every section's notes — on one HTML page. Newer Acts (e.g. Data Protection Act 2018) serve only a "view PDF" stub at `/notes`; the real content sits under `/notes/contents`, split into numbered "divisions" (chapters), with per-section commentary living in whichever division is titled "Commentary on provisions of Act". `get_explanatory_notes` tries the flat page first and falls back to locating that division. Not every Act has notes at all (Appropriation, Consolidated Fund, Finance and Consolidation Acts never get them), and not every section gets its own paragraph — some are grouped or unremarked.

## Auth

None. legislation.gov.uk is keyless and free.

## Data sources

- [legislation.gov.uk](https://www.legislation.gov.uk) — full text as CLML XML at `/{type}/{year}/{number}/data.xml`, section-level at `/{type}/{year}/{number}/section/{n}/data.xml`, versioned via `/enacted` or `/{date}` path segments; search via the Atom feed at `/{type}/data.feed`; amendments via the Atom feed at `/changes/{affected|affecting}/{type}/{year}/{number}/data.feed`; Explanatory Notes as HTML at `/{type}/{year}/{number}/notes` (and `/notes/contents` for larger, division-split Acts).

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

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/search_uk_legislation \
  -H 'Content-Type: application/json' \
  -d '{"type":"ukpga","title":"equality"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/search_uk_legislation`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "legislation-uk": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-legislation-uk"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-legislation-uk
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

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
