interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * legislation.gov.uk MCP — the UK's official legislation database.
 *
 * UK legislation ONLY (England/Wales/Scotland/Northern Ireland). Keyless.
 * The API serves XML/Atom, not JSON. No XML parser is available in the Worker,
 * so fields are extracted with regex on a best-effort basis; every response
 * includes the canonical full-text URL and a raw XML excerpt for verification.
 *
 * Document types: ukpga (UK Public General Acts), uksi (UK Statutory
 * Instruments), asp (Acts of the Scottish Parliament), anaw / asc (Wales),
 * nia (Northern Ireland Acts), ukla (UK Local Acts).
 */


const BASE = 'https://www.legislation.gov.uk';
const UA = 'pipeworx-mcp-legislation-uk/1.0 (+https://pipeworx.io)';

const TYPES =
  'ukpga (UK Public General Acts), uksi (UK Statutory Instruments), asp (Scottish Parliament Acts), anaw/asc (Wales), nia (Northern Ireland), ukla (UK Local Acts)';

const tools: McpToolExport['tools'] = [
  {
    name: 'search_legislation',
    description:
      'Search UK legislation by title words (and optional year), returning matching Acts/instruments with their full-text URLs. ' +
      `UK legislation only. Source: legislation.gov.uk Atom feed. Document types: ${TYPES}.`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: `Document type, e.g. "ukpga". One of: ${TYPES}.`,
        },
        title: { type: 'string', description: 'Words to match in the title, e.g. "equality".' },
        year: { type: 'number', description: 'Optional year to restrict results, e.g. 2010.' },
        page: { type: 'number', description: 'Results page (default 1). 20 results per page.' },
      },
      required: ['type', 'title'],
    },
  },
  {
    name: 'get_legislation',
    description:
      'Get metadata for one specific piece of UK legislation by type + year + number (e.g. ukpga/2010/15 = Equality Act 2010). ' +
      'Returns title, type, year, number, status, extent, enactment date, a long-title summary, and the full-text URL. ' +
      'Content is XML; fields are best-effort parsed and a raw excerpt is included.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `Document type, e.g. "ukpga". One of: ${TYPES}.` },
        year: { type: 'number', description: 'Year, e.g. 2010.' },
        number: { type: 'number', description: 'Item number within that year/type, e.g. 15.' },
      },
      required: ['type', 'year', 'number'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_legislation':
      return searchLegislation(args);
    case 'get_legislation':
      return getLegislation(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function searchLegislation(args: Record<string, unknown>): Promise<unknown> {
  const type = reqStr(args, 'type', '"ukpga"');
  const title = reqStr(args, 'title', '"equality"');
  const year = numOrUndef(args.year);
  const page = numOrUndef(args.page) ?? 1;

  // The plain /{type}?title=... endpoint returns HTML; the Atom feed lives at
  // /{type}/data.feed?title=... — confirmed via curl.
  const params = new URLSearchParams({ title });
  if (year !== undefined) params.set('year', String(year));
  params.set('start-page', String(page));
  const url = `${BASE}/${encType(type)}/data.feed?${params.toString()}`;
  const xml = await getText(url);

  const totalResults = numAttr(xml, /<openSearch:totalResults>\s*([0-9]+)\s*<\/openSearch:totalResults>/);
  const results: Array<Record<string, unknown>> = [];
  for (const entry of matchAll(xml, /<entry>([\s\S]*?)<\/entry>/g)) {
    const block = entry[1];
    const itemTitle = decode(firstGroup(block, /<title>([\s\S]*?)<\/title>/));
    // The bare <link href="..."/> (no rel) points to the dated full-text page;
    // the <id> is the canonical id URI.
    const id = firstGroup(block, /<id>([\s\S]*?)<\/id>/)?.trim();
    let url2 = firstGroup(block, /<link\s+href="([^"]+)"\s*\/>/);
    if (!url2) url2 = firstGroup(block, /<link\s+rel="self"\s+href="([^"]+)"/);
    results.push({
      title: itemTitle,
      url: url2 ?? id,
      id,
      year: numAttr(block, /<ukm:Year\s+Value="([0-9]+)"/),
      number: numAttr(block, /<ukm:Number\s+Value="([0-9]+)"/),
      type: attr(block, /<ukm:DocumentMainType\s+Value="([^"]+)"/) ?? type,
      updated: firstGroup(block, /<updated>([\s\S]*?)<\/updated>/)?.trim(),
      published: firstGroup(block, /<published>([\s\S]*?)<\/published>/)?.trim(),
    });
  }

  return {
    source: 'legislation.gov.uk',
    note: 'UK legislation only. Parsed best-effort from an Atom feed.',
    query: { type, title, year, page },
    totalResults,
    count: results.length,
    results,
    feed_url: url,
  };
}

async function getLegislation(args: Record<string, unknown>): Promise<unknown> {
  const type = reqStr(args, 'type', '"ukpga"');
  const year = reqNum(args, 'year', '2010');
  const number = reqNum(args, 'number', '15');

  const docPath = `${encType(type)}/${year}/${number}`;
  const url = `${BASE}/${docPath}/data.xml`;
  const xml = await getText(url);

  const fullTextUrl = `${BASE}/${docPath}`;
  return {
    source: 'legislation.gov.uk',
    note: 'UK legislation only. Content is XML (CLML); fields parsed best-effort. See full_text_url for the authoritative text.',
    title: decode(firstGroup(xml, /<dc:title>([\s\S]*?)<\/dc:title>/)),
    type: attr(xml, /<ukm:DocumentMainType\s+Value="([^"]+)"/) ?? type,
    category: attr(xml, /<ukm:DocumentCategory\s+Value="([^"]+)"/),
    year: numAttr(xml, /<ukm:Year\s+Value="([0-9]+)"/) ?? Number(year),
    number: numAttr(xml, /<ukm:Number\s+Value="([0-9]+)"/) ?? Number(number),
    status: attr(xml, /<ukm:DocumentStatus\s+Value="([^"]+)"/),
    // RestrictExtent on the root <Legislation> element, e.g. "E+W+S+N.I."
    extent: attr(xml, /\bRestrictExtent="([^"]+)"/),
    enactment_date: attr(xml, /<ukm:EnactmentDate\s+Date="([^"]+)"/),
    modified: firstGroup(xml, /<dc:modified>([\s\S]*?)<\/dc:modified>/)?.trim(),
    isbn: attr(xml, /<ukm:ISBN\s+Value="([^"]+)"/),
    publisher: decode(firstGroup(xml, /<dc:publisher>([\s\S]*?)<\/dc:publisher>/)),
    summary: decode(firstGroup(xml, /<dc:description>([\s\S]*?)<\/dc:description>/)),
    full_text_url: fullTextUrl,
    data_url: url,
    raw_excerpt: xml.slice(0, 1200),
  };
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: 'application/atom+xml, application/xml', 'User-Agent': UA } });
  const body = await res.text();
  if (!res.ok) throw new Error(`legislation.gov.uk: ${res.status} ${body.slice(0, 200)}`);
  return body;
}

// --- XML/Atom helpers (regex-based; no XML libs in the Worker) ---

function encType(type: string): string {
  return encodeURIComponent(type.trim().replace(/^\/+|\/+$/g, ''));
}

function* matchAll(s: string, re: RegExp): Generator<RegExpExecArray> {
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) yield m;
}

function firstGroup(s: string, re: RegExp): string | undefined {
  const m = re.exec(s);
  return m ? m[1] : undefined;
}

function attr(s: string, re: RegExp): string | undefined {
  const v = firstGroup(s, re);
  return v ? decode(v) : undefined;
}

function numAttr(s: string, re: RegExp): number | undefined {
  const v = firstGroup(s, re);
  return v !== undefined ? Number(v) : undefined;
}

function decode(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim())
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  return v.trim();
}

function reqNum(args: Record<string, unknown>, key: string, example: string): number {
  const n = numOrUndef(args[key]);
  if (n === undefined) throw new Error(`Required argument "${key}" is missing. Pass a number like ${example}.`);
  return n;
}

function numOrUndef(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
