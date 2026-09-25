interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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
 *
 * POINT-IN-TIME IS THE TRAP HERE, and it is a wrong answer with a confident
 * face rather than an error. UK legislation exists in versions: the text AS
 * ENACTED, and the text AS AMENDED at a given date. They are not cosmetically
 * different. Section 5 of the Data Protection Act 2018 reads "Terms used in
 * Chapter 2 of this Part and in the GDPR" as enacted, and "Terms used in ...
 * this Part and in the UK GDPR" as it stands today — post-Brexit amendment
 * changed both the instrument referred to and the scope. Quoting the wrong one
 * misstates current law while looking perfectly authoritative, so every text
 * response here names the version it served and the date that version took
 * effect. Never serve one silently.
 *
 * SIZE IS THE OTHER TRAP. The whole-Act XML for a large statute is enormous —
 * the Data Protection Act 2018 is 5.9 MB, its table of contents alone 1.4 MB —
 * and this runs in a Worker with a hard isolate ceiling. Every fetch here is
 * bounded by bytes read, never by trusting the far end to be reasonable.
 *
 * AMENDMENTS ARE PAGED AT 50 (data.feed), never the total — legislation.gov.uk
 * reports `<openSearch:totalResults>` and `<leg:totalPages>` on every page, and
 * this pack surfaces both rather than letting a caller mistake one page for the
 * whole change history (the Data Protection Act 2018 alone has 2,271+ recorded
 * effects across 46 pages).
 *
 * POINT-IN-TIME REDIRECTS SILENTLY, another version of the same trap as above:
 * ask for a date with no amendment on it and legislation.gov.uk serves the
 * nearest EARLIER version without changing the URL (Content-Location echoes
 * the date you asked for) — the served date is recoverable only from the
 * document's own RestrictStartDate/dct:valid metadata, which can differ from
 * the date you passed. Every as_at response says so explicitly.
 *
 * EXPLANATORY NOTES HAVE NO XML — data.xml 404s; only /notes (HTML) exists,
 * and its template varies by the Act's age: older Acts (e.g. Equality Act
 * 2010) put the whole commentary, section headings included, on one HTML
 * page; newer Acts (e.g. Data Protection Act 2018) serve only a PDF stub at
 * /notes and split the real content into numbered HTML "divisions" under
 * /notes/contents, with per-section commentary living in whichever division
 * is titled "Commentary on provisions of Act". Not every Act has notes at
 * all (Appropriation, Consolidated Fund, Finance and Consolidation Acts never
 * get them) and not every section gets its own paragraph.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'legislation.gov.uk');
}

const BASE = 'https://www.legislation.gov.uk';
const UA = 'pipeworx-mcp-legislation-uk/1.0 (+https://pipeworx.io)';

const VERSION_HELP =
  '"current" (default — the law as amended and in force today), "enacted" (the original text as passed), or a date YYYY-MM-DD for the text as it stood on that day.';

const TYPES =
  'ukpga (UK Public General Acts), uksi (UK Statutory Instruments), asp (Scottish Parliament Acts), anaw/asc (Wales), nia (Northern Ireland), ukla (UK Local Acts)';

// An agent without the exact type code otherwise gets `invalid_arguments` —
// accept a plain-English category as an alternative and map it, defaulting to
// the most common type (Acts of Parliament) when nothing at all is given.
const CATEGORY_ALIASES: Record<string, string> = {
  act: 'ukpga',
  acts: 'ukpga',
  si: 'uksi',
  sis: 'uksi',
  'statutory instrument': 'uksi',
  'statutory instruments': 'uksi',
  ssi: 'ssi',
  'scottish statutory instrument': 'ssi',
  'scottish statutory instruments': 'ssi',
};
const DEFAULT_TYPE = 'ukpga';

function resolveType(v: unknown): { type: string; defaulted: boolean; note?: string } {
  if (typeof v !== 'string' || !v.trim()) {
    return {
      type: DEFAULT_TYPE,
      defaulted: true,
      note: `No "type" given — defaulted to "${DEFAULT_TYPE}" (UK Public General Acts). Pass type to search other document types: ${TYPES}.`,
    };
  }
  const raw = v.trim();
  const alias = CATEGORY_ALIASES[raw.toLowerCase()];
  if (alias) {
    return { type: alias, defaulted: false, note: `"${raw}" mapped to type "${alias}".` };
  }
  return { type: raw, defaulted: false };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'search_uk_legislation',
    description:
      'Search UK legislation by title words (and optional year), returning matching Acts/instruments with their full-text URLs. ' +
      `UK legislation only. Source: legislation.gov.uk Atom feed. Document types: ${TYPES}. ` +
      `"type" is optional: give an exact code (e.g. "ukpga"), a plain category ("act", "si", "ssi"), or omit it entirely — omitted defaults to "${DEFAULT_TYPE}" and the response says so.`,
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: `Document type code (e.g. "ukpga") or category ("act", "si", "ssi"). Optional — defaults to "${DEFAULT_TYPE}" if omitted. Full code list: ${TYPES}.`,
        },
        title: { type: 'string', description: 'Words to match in the title, e.g. "equality".' },
        year: { type: 'number', description: 'Optional year to restrict results, e.g. 2010.' },
        page: { type: 'number', description: 'Results page (default 1). 20 results per page.' },
      },
      required: ['title'],
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
  {
    name: 'get_legislation_section',
    description:
      'Read the actual WORDS of one section of a UK Act or statutory instrument — "what does section 5 of the Data Protection Act 2018 say", "quote section 1 of the Human Rights Act", "text of s.170 DPA 2018". Returns the full text of that section alone, so a specific provision does not cost a whole statute. '
      + 'Identify the legislation by type + year + number (Data Protection Act 2018 = ukpga/2018/12) and give the section number. '
      + 'UK law exists in VERSIONS and they differ in substance: pass version to choose ' + VERSION_HELP + ' as_at is an alias for a date version (e.g. as_at: "2019-01-01") — the same date is also accepted via version. '
      + 'legislation.gov.uk serves the NEAREST EARLIER version for a date with no amendment on it rather than erroring, so every response states the version it actually served (version_valid_from) alongside the date asked for, even when they differ. Source: legislation.gov.uk, the official database. Use search_uk_legislation or get_legislation first if you need the year and number.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `Document type, e.g. "ukpga". One of: ${TYPES}.` },
        year: { type: 'number', description: 'Year, e.g. 2018.' },
        number: { type: 'number', description: 'Item number within that year/type, e.g. 12 for the Data Protection Act 2018.' },
        section: { type: 'string', description: 'Section number, e.g. "5", "170", or "5A" for an inserted section.' },
        version: { type: 'string', description: `Which version of the text: ${VERSION_HELP}` },
        as_at: { type: 'string', description: 'YYYY-MM-DD — the law as it stood on this date. Alias for a date "version"; the response states the actual served version date, which may be earlier than this if nothing changed on the exact date given.' },
      },
      required: ['type', 'year', 'number', 'section'],
    },
  },
  {
    name: 'get_legislation_text',
    description:
      'Read the text of a whole UK Act or statutory instrument — the body of the law rather than a catalogue entry. Use for short instruments and for reading an Act end to end; for one provision prefer get_legislation_section, which returns just that section. '
      + 'Large Acts run to megabytes, so this reads a bounded amount and says plainly when it stopped short rather than returning a silently clipped statute. '
      + 'UK law exists in VERSIONS that differ in substance: pass version to choose ' + VERSION_HELP + ' as_at is an alias for a date version (e.g. as_at: "2019-01-01"). '
      + 'legislation.gov.uk serves the NEAREST EARLIER version for a date with no amendment on it rather than erroring, so every response states the version it actually served (version_valid_from) alongside the date asked for, even when they differ. Source: legislation.gov.uk, the official database.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `Document type, e.g. "ukpga". One of: ${TYPES}.` },
        year: { type: 'number', description: 'Year, e.g. 2018.' },
        number: { type: 'number', description: 'Item number within that year/type, e.g. 12.' },
        version: { type: 'string', description: `Which version of the text: ${VERSION_HELP}` },
        as_at: { type: 'string', description: 'YYYY-MM-DD — the law as it stood on this date. Alias for a date "version"; the response states the actual served version date, which may be earlier than this if nothing changed on the exact date given.' },
      },
      required: ['type', 'year', 'number'],
    },
  },
  {
    name: 'legislation_amendments',
    description:
      'What has amended this UK Act or instrument, and (in the other direction) what this legislation itself amends — "what has changed the Data Protection Act 2018", "has section 13A been amended", "what does the Victims and Prisoners Act 2024 amend". '
      + 'Each row names the amending/amended instrument, the affected and affecting provisions, the type of change (inserted/substituted/repealed/omitted/amended etc.), whether it has actually been APPLIED (some amendments are made but not yet in force), and the commencement date. '
      + 'PAGED AT 50 — the response states total_results and total_pages; 50 rows is a page, never the whole change history (some Acts have thousands of recorded effects), pass page for more. '
      + 'direction "affected" (default) = changes made TO this legislation by others; "affecting" = changes this legislation makes TO others. Source: legislation.gov.uk /changes/ Atom feed.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `Document type, e.g. "ukpga". One of: ${TYPES}.` },
        year: { type: 'number', description: 'Year, e.g. 2018.' },
        number: { type: 'number', description: 'Item number within that year/type, e.g. 12 for the Data Protection Act 2018.' },
        direction: {
          type: 'string',
          description: '"affected" (default) — changes made TO this legislation by other instruments. "affecting" — changes this legislation makes TO other instruments.',
        },
        page: { type: 'number', description: 'Results page (default 1). 50 rows per page — see total_pages in the response.' },
      },
      required: ['type', 'year', 'number'],
    },
  },
  {
    name: 'get_explanatory_notes',
    description:
      'Read the Explanatory Notes for a UK Act — plain-language commentary written by the government department responsible, explaining what a section is meant to do and why. NOT part of the law and not endorsed by Parliament — use for context on intent, never as the text of the law itself (use get_legislation_section for that). '
      + 'Pass section to get the commentary for just that section; omit it for an overview plus the notes\' own table of contents. '
      + 'Not every Act has notes (Appropriation, Consolidated Fund, Finance and Consolidation Acts never get them) and not every section gets its own paragraph — some are grouped or unremarked. Notes are written for the Act AS ENACTED and are not updated for later amendments. Source: legislation.gov.uk (HTML only — there is no XML/data feed for notes).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: `Document type, e.g. "ukpga". One of: ${TYPES}.` },
        year: { type: 'number', description: 'Year, e.g. 2018.' },
        number: { type: 'number', description: 'Item number within that year/type, e.g. 12 for the Data Protection Act 2018.' },
        section: { type: 'string', description: 'Optional: section number, e.g. "5", to get just that section\'s commentary. Omit for an overview.' },
      },
      required: ['type', 'year', 'number'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_uk_legislation':
    case 'search_legislation': // pre-rename name; keep resolving (fleet #2256)
      return searchLegislation(args);
    case 'get_legislation':
      return getLegislation(args);
    case 'get_legislation_section':
      return getLegislationSection(args);
    case 'get_legislation_text':
      return getLegislationText(args);
    case 'legislation_amendments':
      return getLegislationAmendments(args);
    case 'get_explanatory_notes':
      return getExplanatoryNotes(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function searchLegislation(args: Record<string, unknown>): Promise<unknown> {
  const { type, defaulted, note: typeNote } = resolveType(args.type);
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
    note: 'UK legislation only. Parsed best-effort from an Atom feed.' + (typeNote ? ` ${typeNote}` : ''),
    type_defaulted: defaulted,
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

/**
 * Read at most maxBytes of a response, then stop.
 *
 * Not a nicety: the whole-Act XML for the Data Protection Act 2018 is 5.9 MB
 * and legislation.gov.uk will happily send all of it. A Worker that
 * materialises that alongside a routing working set is how the isolate ceiling
 * gets hit, so the cap is enforced on OUR side of the socket rather than by
 * asking politely.
 */
async function getTextBounded(url: string, maxBytes: number): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const res = await pwFetch(url, { headers: { Accept: 'application/xml', 'User-Agent': UA } });
  if (!res.ok) {
    const peek = await res.text();
    throw new Error(`legislation.gov.uk: ${res.status} ${peek.slice(0, 200)}`);
  }
  if (!res.body) {
    const whole = await res.text();
    return { text: whole.slice(0, maxBytes), truncated: whole.length > maxBytes, bytes: whole.length };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total >= maxBytes) { truncated = true; await reader.cancel(); break; }
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { text: new TextDecoder().decode(buf), truncated, bytes: total };
}

/** CLML marks repealed/omitted material; keep it visible rather than silently dropping it. */
function xmlToText(xml: string): string {
  return xml
    .replace(/<Commentary[\s\S]*?<\/Commentary>/g, ' ')
    // Strip the metadata BLOCK by name, with a backreference. The obvious
    // /<ukm:[\s\S]*?<\/ukm:[A-Za-z]+>/ looks non-greedy and is not safe: ukm:
    // elements bracket the whole file, so the first opening tag pairs with a
    // LATER closing tag of a different name and the entire provision
    // disappears between them. Measured on section 5 DPA 2018: it reduced a
    // 36 kB document to 69 characters of headings — a confident, empty answer.
    .replace(/<ukm:Metadata\b[\s\S]*?<\/ukm:Metadata>/g, ' ')
    .replace(/<ukm:([A-Za-z]+)\b[^>]*\/>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim();
}


// ── Version handling ──────────────────────────────────────────────────────
//
// legislation.gov.uk expresses versions in the PATH:
//   /ukpga/2018/12/section/5            current, i.e. as amended to date
//   /ukpga/2018/12/section/5/enacted    the text as originally passed
//   /ukpga/2018/12/section/5/2020-01-01 the text as it stood on that date
// The three return materially different words, so which one was asked for has
// to survive into the answer.
function versionSegment(v: unknown): { seg: string; label: string } {
  if (typeof v !== 'string' || !v.trim() || v.trim().toLowerCase() === 'current') {
    return { seg: '', label: 'current (as amended and in force today)' };
  }
  const t = v.trim().toLowerCase();
  if (t === 'enacted' || t === 'as-enacted' || t === 'as enacted') {
    return { seg: '/enacted', label: 'as enacted (the original text as passed, ignoring later amendments)' };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return { seg: `/${t}`, label: `as it stood on ${t}` };
  }
  throw new Error(`Unrecognised "version": ${v}. Use ${VERSION_HELP}`);
}

/**
 * as_at is a plain-English alias for a date-shaped "version" — accept either,
 * or both if they agree, and reject the ambiguous case of two DIFFERENT
 * dates rather than silently picking one.
 */
function resolveVersion(args: Record<string, unknown>): { seg: string; label: string; requestedDate: string | null } {
  const asAt = typeof args.as_at === 'string' && args.as_at.trim() ? args.as_at.trim() : undefined;
  const version = typeof args.version === 'string' && args.version.trim() ? args.version.trim() : undefined;
  if (asAt && !/^\d{4}-\d{2}-\d{2}$/.test(asAt)) {
    throw new Error(`Unrecognised "as_at": ${asAt}. Use a date like "2019-01-01".`);
  }
  if (asAt && version && version.toLowerCase() !== 'current' && version !== asAt) {
    throw new Error(`"as_at" (${asAt}) and "version" (${version}) disagree — pass only one.`);
  }
  const chosen = asAt ?? version;
  const { seg, label } = versionSegment(chosen);
  return { seg, label, requestedDate: asAt ?? (chosen && /^\d{4}-\d{2}-\d{2}$/.test(chosen) ? chosen : null) };
}

/** The date the served version took effect, straight from the document. */
function versionValidFrom(xml: string): string | undefined {
  return attr(xml, /\bRestrictStartDate="([^"]+)"/)
    ?? firstGroup(xml, /<dct:valid>([^<]+)<\/dct:valid>/)?.trim();
}

const SECTION_MAX_BYTES = 400_000;
const ACT_MAX_BYTES = 1_200_000;

async function getLegislationSection(args: Record<string, unknown>): Promise<unknown> {
  const type = reqStr(args, 'type', '"ukpga"');
  const year = reqNum(args, 'year', '2018');
  const number = reqNum(args, 'number', '12');
  const sectionRaw = args.section;
  if (sectionRaw === undefined || sectionRaw === null || String(sectionRaw).trim() === '') {
    throw new Error('Required argument "section" is missing. Pass the section number, e.g. 5 (or "5A").');
  }
  const section = String(sectionRaw).trim().replace(/^s(ection)?\.?\s*/i, '');
  const { seg, label, requestedDate } = resolveVersion(args);

  const docPath = `${encType(type)}/${year}/${number}`;
  const url = `${BASE}/${docPath}/section/${encodeURIComponent(section)}${seg}/data.xml`;

  let got;
  try {
    got = await getTextBounded(url, SECTION_MAX_BYTES);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b404\b/.test(msg)) {
      return {
        found: false,
        reason: 'section_not_found',
        hint: `No section ${section} in ${docPath}${seg ? ` for version ${label}` : ''}. Numbering differs between versions — a section inserted by a later amendment does not exist in the "enacted" text. Call get_legislation for the section list.`,
        source: 'legislation.gov.uk',
      };
    }
    throw e;
  }

  // Capture groups are load-bearing: firstGroup returns m[1], so a regex
  // without one silently yields undefined and falls through to the whole
  // document — which is how the amended text came back as 69 characters of
  // headings while the as-enacted text, structured differently, looked fine.
  const body = firstGroup(got.text, /(<P1group[\s\S]*<\/P1group>)/)
    ?? firstGroup(got.text, /(<Pblock[\s\S]*<\/Pblock>)/)
    ?? firstGroup(got.text, /(<Body[\s\S]*<\/Body>)/)
    ?? got.text;
  const text = xmlToText(body);
  const servedDate = versionValidFrom(got.text) ?? null;

  return {
    found: text.length > 0,
    legislation: docPath,
    title: decode(firstGroup(got.text, /<dc:title>([\s\S]*?)<\/dc:title>/)),
    section,
    // Stated on EVERY response — the same section reads differently across
    // versions and a quote without its version is not verifiable.
    version: label,
    as_at: requestedDate,
    // The date the SERVED text actually took effect. legislation.gov.uk
    // silently serves the nearest EARLIER version for a date with no
    // amendment on it, so this can differ from `as_at` above — surface both
    // rather than letting a caller assume the exact date they asked for.
    version_valid_from: servedDate,
    version_note: requestedDate && servedDate && servedDate !== requestedDate
      ? `Asked for ${requestedDate}; no change took effect exactly then, so legislation.gov.uk served the version in force from ${servedDate} (the nearest earlier version) instead.`
      : null,
    text,
    characters: text.length,
    truncated: got.truncated,
    url: `${BASE}/${docPath}/section/${section}${seg}`,
    data_url: url,
    source: 'legislation.gov.uk',
    note: 'Text of one section only. Repealed or omitted words appear as runs of dots in the amended text, exactly as legislation.gov.uk renders them.',
  };
}

async function getLegislationText(args: Record<string, unknown>): Promise<unknown> {
  const type = reqStr(args, 'type', '"ukpga"');
  const year = reqNum(args, 'year', '2018');
  const number = reqNum(args, 'number', '12');
  const { seg, label, requestedDate } = resolveVersion(args);
  const docPath = `${encType(type)}/${year}/${number}`;
  const url = `${BASE}/${docPath}${seg}/data.xml`;

  const got = await getTextBounded(url, ACT_MAX_BYTES);
  const text = xmlToText(got.text);
  const servedDate = versionValidFrom(got.text) ?? null;

  return {
    found: text.length > 0,
    legislation: docPath,
    title: decode(firstGroup(got.text, /<dc:title>([\s\S]*?)<\/dc:title>/)),
    version: label,
    as_at: requestedDate,
    version_valid_from: servedDate,
    version_note: requestedDate && servedDate && servedDate !== requestedDate
      ? `Asked for ${requestedDate}; no change took effect exactly then, so legislation.gov.uk served the version in force from ${servedDate} (the nearest earlier version) instead.`
      : null,
    text,
    characters: text.length,
    bytes_read: got.bytes,
    truncated: got.truncated,
    // Said plainly rather than left for the caller to infer from a cut-off
    // sentence. A large Act runs to megabytes and this deliberately does not
    // return all of it.
    truncation_note: got.truncated
      ? `This Act is larger than the ${(ACT_MAX_BYTES / 1000).toFixed(0)}kB this tool will read in one call, so the text above stops partway. For a specific provision call get_legislation_section({type, year, number, section}), which returns that section complete.`
      : null,
    url: `${BASE}/${docPath}${seg}`,
    source: 'legislation.gov.uk',
  };
}

async function getText(url: string): Promise<string> {
  const res = await pwFetch(url, { headers: { Accept: 'application/atom+xml, application/xml', 'User-Agent': UA } });
  const body = await res.text();
  if (!res.ok) throw new Error(`legislation.gov.uk: ${res.status} ${body.slice(0, 200)}`);
  return body;
}

// ── Amendments ("changes") ──────────────────────────────────────────────────
//
// /changes/affected/{type}/{year}/{number}/data.feed = changes made TO this
// legislation by other instruments (what amended it).
// /changes/affecting/{type}/{year}/{number}/data.feed = changes THIS
// legislation makes TO other instruments (the reverse direction) — verified
// live 2026-09-18; the task's suggested "/changes/made/..." 404s, "affecting"
// is the real path.
// Each <entry> wraps one <ukm:Effect> element carrying the change as
// attributes (Type, Applied, Modified, Comments, the affected/affecting
// year+number+URI) plus child elements naming the specific provisions.
const AMENDMENTS_PAGE_SIZE = 50;

async function getLegislationAmendments(args: Record<string, unknown>): Promise<unknown> {
  const type = reqStr(args, 'type', '"ukpga"');
  const year = reqNum(args, 'year', '2018');
  const number = reqNum(args, 'number', '12');
  const dirRaw = typeof args.direction === 'string' ? args.direction.trim().toLowerCase() : 'affected';
  const direction = dirRaw === 'affecting' ? 'affecting' : 'affected';
  const page = Math.max(1, Math.trunc(numOrUndef(args.page) ?? 1));

  const docPath = `${encType(type)}/${year}/${number}`;
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  const qs = params.toString();
  const url = `${BASE}/changes/${direction}/${docPath}/data.feed${qs ? `?${qs}` : ''}`;
  const xml = await getText(url);

  const totalResults = numAttr(xml, /<openSearch:totalResults>\s*([0-9]+)\s*<\/openSearch:totalResults>/) ?? 0;
  const totalPages = numAttr(xml, /<leg:totalPages>\s*([0-9]+)\s*<\/leg:totalPages>/) ?? 1;
  const perPage = numAttr(xml, /<openSearch:itemsPerPage>\s*([0-9]+)\s*<\/openSearch:itemsPerPage>/) ?? AMENDMENTS_PAGE_SIZE;

  const amendments: Array<Record<string, unknown>> = [];
  for (const entry of matchAll(xml, /<entry>([\s\S]*?)<\/entry>/g)) {
    const block = entry[1];
    const entryTitle = decode(firstGroup(block, /<title>([\s\S]*?)<\/title>/));
    const effectWhole = extractTag(block, 'ukm:Effect');
    if (!effectWhole) {
      amendments.push({ title: entryTitle, raw_excerpt: block.slice(0, 400) });
      continue;
    }
    const a = parseAttrs(effectWhole);
    const inForce = extractTag(effectWhole, 'ukm:InForce');
    amendments.push({
      title: entryTitle,
      type: a.Type ?? null,
      applied: a.Applied === 'true' ? true : a.Applied === 'false' ? false : null,
      comments: a.Comments ?? null,
      modified: a.Modified ?? null,
      affecting: {
        title: decode(firstGroup(effectWhole, /<ukm:AffectingTitle>([\s\S]*?)<\/ukm:AffectingTitle>/)) ?? null,
        year: a.AffectingYear ? Number(a.AffectingYear) : null,
        number: a.AffectingNumber ? Number(a.AffectingNumber) : null,
        class: a.AffectingClass ?? null,
        provisions: sectionRefs(effectWhole, 'AffectingProvisions'),
        uri: a.AffectingURI ?? null,
      },
      affected: {
        title: decode(firstGroup(effectWhole, /<ukm:AffectedTitle>([\s\S]*?)<\/ukm:AffectedTitle>/)) ?? null,
        year: a.AffectedYear ? Number(a.AffectedYear) : null,
        number: a.AffectedNumber ? Number(a.AffectedNumber) : null,
        class: a.AffectedClass ?? null,
        provisions: sectionRefs(effectWhole, 'AffectedProvisions'),
        uri: a.AffectedURI ?? null,
      },
      commencement_date: inForce ? (parseAttrs(inForce).Date ?? null) : null,
      wholly_in_force: inForce ? /wholly in force/i.test(parseAttrs(inForce).Qualification ?? '') : null,
    });
  }

  return {
    source: 'legislation.gov.uk',
    legislation: docPath,
    direction,
    note: direction === 'affected'
      ? 'Changes made TO this legislation by other instruments — what amended it. Pass direction: "affecting" for the reverse (what this legislation amends).'
      : 'Changes this legislation makes TO other instruments. Pass direction: "affected" (default) for the reverse (what amended this legislation).',
    page,
    per_page: perPage,
    total_results: totalResults,
    total_pages: totalPages,
    has_more: page < totalPages,
    next_page: page < totalPages ? page + 1 : null,
    // 50 is a PAGE, never the total — stated explicitly so a caller does not
    // mistake one page's row count for the whole change history.
    paging_note: `This is page ${page} of ${totalPages} (${totalResults} total recorded changes, ${perPage} per page). Pass page: ${page + 1} for more.`,
    count: amendments.length,
    amendments,
    feed_url: url,
  };
}

// ── Explanatory Notes ───────────────────────────────────────────────────────
//
// No XML/data feed exists for notes — data.xml 404s (verified live). Only
// HTML, and the template differs by the Act's age:
//   OLD template (e.g. Equality Act 2010): /notes alone returns the whole
//     commentary on one page, headings like
//     <h5 class="...ENCommentaryP1..."><a href="...">Section 5</a>: Title</h5>.
//   NEW template (e.g. Data Protection Act 2018): /notes is a PDF-only stub;
//     the real content is under /notes/contents, split into numbered
//     "divisions" (chapters), with per-section commentary living in whichever
//     division is titled "Commentary on provisions of Act" — headings like
//     <h4 class="HSubheading4">Section 5: Title</h4> (no anchor).
const NOTES_MAX_BYTES = 1_500_000;

async function getHtmlBounded(url: string, maxBytes: number): Promise<{ text: string; truncated: boolean; bytes: number; status: number }> {
  const res = await pwFetch(url, { headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': UA } });
  if (!res.body) {
    const whole = await res.text();
    return { text: whole.slice(0, maxBytes), truncated: whole.length > maxBytes, bytes: whole.length, status: res.status };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      chunks.push(value);
      if (total >= maxBytes) { truncated = true; await reader.cancel(); break; }
    }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return { text: new TextDecoder().decode(buf), truncated, bytes: total, status: res.status };
}

/** Strip tags/scripts/entities from an HTML fragment; keep paragraph breaks. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strip any nested tags from a heading's inner HTML, leaving plain text. */
function stripTags(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) ?? '';
}

function normSection(s: string): string {
  return s.trim().toUpperCase().replace(/^S(ECTION)?\.?\s*/, '');
}

/**
 * Find a "Section N: Title" heading (h1–h6, with or without an anchor
 * wrapping "Section N") and return the text between it and the next heading.
 * Covers both the old template (anchor-wrapped) and the new one (plain text).
 */
function extractSectionNotes(html: string, sectionId: string): { title: string | null; text: string; found: boolean } {
  const target = normSection(sectionId);
  const re = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  const all: Array<{ start: number; end: number; plain: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    all.push({ start: m.index, end: m.index + m[0].length, plain: stripTags(m[1]) });
  }
  // Only STRUCTURAL headings (Section/Part/Chapter/Schedule/Annex) bound a
  // section's commentary — a section's own sub-headings (e.g. "Effect",
  // "Background") sit at the SAME heading level as "Section N" in some
  // templates and would otherwise end the extraction one paragraph in.
  // Measured on Equality Act 2010 s.1: "Section 1: ..." is immediately
  // followed by a sibling "<h5>Effect</h5>" heading before any body text.
  const boundaries = all.filter((h) => /^(Section|Part|Chapter|Schedule|Annex)\b/i.test(h.plain));
  for (let i = 0; i < boundaries.length; i++) {
    const h = boundaries[i];
    const mm = /^Section\s+([0-9]+[A-Za-z]{0,3})\s*:?\s*(.*)$/i.exec(h.plain);
    if (!mm) continue;
    if (normSection(mm[1]) !== target) continue;
    const bodyStart = h.end;
    const bodyEnd = i + 1 < boundaries.length ? boundaries[i + 1].start : Math.min(html.length, bodyStart + 20_000);
    return { title: mm[2]?.trim() || null, text: htmlToText(html.slice(bodyStart, bodyEnd)), found: true };
  }
  return { title: null, text: '', found: false };
}

/**
 * Every notes-division link on a page, deduped by division number, across
 * both templates: the new template links siblings RELATIVELY from inside
 * .../notes/division/1/index.htm (href="../2/index.htm"), the old template
 * links ABSOLUTELY from .../notes/contents (href="/ukpga/2010/15/notes/division/2").
 * Neither form necessarily contains the substring "notes/division", so both
 * shapes are matched explicitly rather than by one substring pattern.
 */
function extractDivisions(html: string, docPath: string): Array<{ number: string; title: string; url: string }> {
  const re = /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi;
  const seen = new Set<string>();
  const out: Array<{ number: string; title: string; url: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    let number: string | undefined;
    let url: string | undefined;
    const rel = /^\.\.\/([0-9]+(?:\/[0-9]+)*)\/index\.htm$/.exec(href);
    const abs = /\/notes\/division\/([0-9]+(?:\/[0-9]+)*)(?:\/index\.htm)?\/?$/.exec(href);
    if (rel) {
      number = rel[1];
      url = `${BASE}/${docPath}/notes/division/${number}/index.htm`;
    } else if (abs) {
      number = abs[1];
      url = href.startsWith('http') ? href : `${BASE}${href}`;
    }
    if (!number || !url || seen.has(number)) continue;
    seen.add(number);
    out.push({ number, title: decode(m[2])?.trim() ?? '', url });
  }
  return out;
}

async function getExplanatoryNotes(args: Record<string, unknown>): Promise<unknown> {
  const type = reqStr(args, 'type', '"ukpga"');
  const year = reqNum(args, 'year', '2018');
  const number = reqNum(args, 'number', '12');
  const sectionRaw = args.section;
  const section = typeof sectionRaw === 'string' && sectionRaw.trim() ? sectionRaw.trim() : undefined;
  const docPath = `${encType(type)}/${year}/${number}`;
  const NOT_LAW_NOTE = 'Explanatory Notes are written by the government department responsible for the Act to help a non-lawyer reader. They are NOT part of the law, were not endorsed by Parliament, and are written for the Act as enacted — they are not updated for later amendments.';

  const flatUrl = `${BASE}/${docPath}/notes`;
  const flat = await getHtmlBounded(flatUrl, NOTES_MAX_BYTES);
  if (flat.status === 404) {
    return {
      found: false,
      reason: 'no_explanatory_notes',
      hint: 'legislation.gov.uk has no Explanatory Notes for this item. Appropriation, Consolidated Fund, Finance and Consolidation Acts never get them; older statutory instruments often do not either.',
      url: flatUrl,
      source: 'legislation.gov.uk',
    };
  }

  // Old-template Acts put the whole commentary, section headings included,
  // on this one page — try extraction here before fetching anything else.
  const hasFlatSections = /<h[1-6][^>]*>\s*(?:<a[^>]*>[^<]*<\/a>\s*)?Section\s+[0-9]/i.test(flat.text);
  if (hasFlatSections) {
    if (section) {
      const hit = extractSectionNotes(flat.text, section);
      if (hit.found) {
        return {
          found: true,
          legislation: docPath,
          section: normSection(section),
          section_title: hit.title,
          text: hit.text,
          characters: hit.text.length,
          url: flatUrl,
          source: 'legislation.gov.uk',
          note: NOT_LAW_NOTE,
        };
      }
      return {
        found: false,
        reason: 'section_not_found_in_notes',
        hint: `No "Section ${section}" commentary heading found in the Explanatory Notes for ${docPath}. Not every section gets its own paragraph — some are grouped or unremarked.`,
        url: flatUrl,
        source: 'legislation.gov.uk',
      };
    }
    const introMatch = /What these notes do[\s\S]{0,4000}/i.exec(flat.text);
    return {
      found: true,
      legislation: docPath,
      note: `Overview only — pass "section" (e.g. "5") for one section's commentary. ${NOT_LAW_NOTE}`,
      intro_text: introMatch ? htmlToText(introMatch[0]).slice(0, 3000) : htmlToText(flat.text).slice(0, 3000),
      url: flatUrl,
      truncated: flat.truncated,
      source: 'legislation.gov.uk',
    };
  }

  // New-template Acts: /notes is a PDF-only stub. Real content lives under
  // /notes/contents, split into numbered divisions.
  const contentsUrl = `${BASE}/${docPath}/notes/contents`;
  const contents = await getHtmlBounded(contentsUrl, NOTES_MAX_BYTES);
  if (contents.status === 404) {
    return {
      found: false,
      reason: 'no_explanatory_notes',
      hint: 'legislation.gov.uk has no Explanatory Notes for this item.',
      url: contentsUrl,
      source: 'legislation.gov.uk',
    };
  }
  const divisions = extractDivisions(contents.text, docPath);

  if (!section) {
    const introMatch = /<article>([\s\S]*?)<\/article>/i.exec(contents.text);
    return {
      found: true,
      legislation: docPath,
      note: `Overview only — pass "section" (e.g. "5") for one section's commentary. ${NOT_LAW_NOTE}`,
      intro_text: htmlToText(introMatch ? introMatch[1] : contents.text).slice(0, 3000),
      divisions,
      url: contentsUrl,
      source: 'legislation.gov.uk',
    };
  }

  const commentaryDivision = divisions.find((d) => /commentary|provision/i.test(d.title))
    ?? divisions.find((d) => /clause/i.test(d.title));
  if (!commentaryDivision) {
    return {
      found: false,
      reason: 'commentary_division_not_found',
      hint: 'Could not identify a "Commentary on provisions" division in the Explanatory Notes table of contents for this item.',
      divisions,
      url: contentsUrl,
      source: 'legislation.gov.uk',
    };
  }
  const divPage = await getHtmlBounded(commentaryDivision.url, NOTES_MAX_BYTES);
  const hit = extractSectionNotes(divPage.text, section);
  if (hit.found) {
    return {
      found: true,
      legislation: docPath,
      section: normSection(section),
      section_title: hit.title,
      text: hit.text,
      characters: hit.text.length,
      url: commentaryDivision.url,
      source: 'legislation.gov.uk',
      note: NOT_LAW_NOTE,
    };
  }
  return {
    found: false,
    reason: 'section_not_found_in_notes',
    hint: `No "Section ${section}" commentary heading found in "${commentaryDivision.title}" (${commentaryDivision.url}). Not every section gets its own paragraph, and notes are not updated for later amendments.`,
    divisions,
    url: commentaryDivision.url,
    source: 'legislation.gov.uk',
  };
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

/** Whole element (self-closing or paired), by local name, e.g. "ukm:Effect". */
function extractTag(s: string, tagName: string): string | undefined {
  const esc = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${esc}\\b[^>]*\\/>|<${esc}\\b[^>]*>[\\s\\S]*?<\\/${esc}>`, 'i');
  const m = re.exec(s);
  return m ? m[0] : undefined;
}

/** key="value" attribute pairs off an element's opening tag. */
function parseAttrs(elementXml: string): Record<string, string> {
  const openTag = firstGroupWhole(elementXml, /^<[A-Za-z0-9:]+\b([^>]*)>/) ?? elementXml;
  const out: Record<string, string> = {};
  for (const m of matchAll(openTag, /([A-Za-z][A-Za-z0-9]*)="([^"]*)"/g)) {
    out[m[1]] = decode(m[2]) ?? m[2];
  }
  return out;
}

function firstGroupWhole(s: string, re: RegExp): string | undefined {
  const m = re.exec(s);
  return m ? m[1] : undefined;
}

/** Text of every nested <ukm:Section>/<ukm:Part>/etc inside a named wrapper element, e.g. "AffectedProvisions". */
function sectionRefs(effectXml: string, wrapperLocalName: string): string[] {
  const wrapper = extractTag(effectXml, `ukm:${wrapperLocalName}`);
  if (!wrapper) return [];
  const out: string[] = [];
  for (const m of matchAll(wrapper, /<ukm:[A-Za-z]+\b[^>]*>([^<]*)<\/ukm:[A-Za-z]+>/g)) {
    const t = decode(m[1]);
    if (t) out.push(t);
  }
  return out;
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
