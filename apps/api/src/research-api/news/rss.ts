/**
 * A small RSS 2.0 reader — the four fields a headline needs from each
 * `<item>`, nothing else. Dependency-free on purpose: the feeds are simple,
 * and a general XML parser would be the largest thing in the service for the
 * sake of four tags.
 *
 * Tolerates what the real feeds do: a byte-order mark (RBI), CDATA around
 * every field (Livemint wraps even the link and the date), entities encoded
 * twice inside CDATA (Economic Times writes `M&amp;amp;M`), descriptions full
 * of HTML, and dates without a time zone (RBI — read as IST).
 */

export interface RssItem {
  title: string;
  link: string;
  /** Epoch ms; null when the item has no date that parses. */
  publishedAt: number | null;
  guid: string | null;
}

/** Named entities, by code point — no literal non-ASCII in this file. */
const NAMED: Record<string, number> = {
  amp: 0x26,
  lt: 0x3c,
  gt: 0x3e,
  quot: 0x22,
  apos: 0x27,
  nbsp: 0x20, // read as a plain space
  ndash: 0x2013,
  mdash: 0x2014,
  lsquo: 0x2018,
  rsquo: 0x2019,
  ldquo: 0x201c,
  rdquo: 0x201d,
  hellip: 0x2026,
};

/** A code point as text; a number out of range is left as written. */
function codePoint(code: number, whole: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : whole;
}

function decodeOnce(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, body: string) => {
      if (body.startsWith("#x") || body.startsWith("#X"))
        return codePoint(Number.parseInt(body.slice(2), 16), whole);
      if (body.startsWith("#"))
        return codePoint(Number.parseInt(body.slice(1), 10), whole);
      const named = NAMED[body.toLowerCase()];
      return named === undefined ? whole : String.fromCodePoint(named);
    },
  );
}

/**
 * Entities decoded, twice at most — `&amp;amp;` is how a feed writes `&`
 * inside CDATA it has already escaped — and whitespace (including the
 * non-breaking space) collapsed to single spaces.
 */
export function decodeEntities(text: string): string {
  const once = decodeOnce(text);
  const twice = /&(#x[0-9a-f]+|#\d+|[a-z]+);/i.test(once)
    ? decodeOnce(once)
    : once;
  // `\s` includes the non-breaking space.
  return twice.replace(/\s+/g, " ").trim();
}

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
const ZONES: Record<string, number> = {
  GMT: 0,
  UT: 0,
  UTC: 0,
  Z: 0,
  IST: 330,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  PST: -480,
  PDT: -420,
};
/** Minutes east of UTC that a date without a zone is read in: IST. */
const DEFAULT_ZONE_MINUTES = 330;

/**
 * An RFC 822 date ("Fri, 27 Nov 2026 19:45:00 +0530"), or an ISO one, as
 * epoch ms. A date with no zone is IST — the RBI feed writes its local time
 * bare — never the clock of whatever machine runs this.
 */
export function parseRssDate(value: string): number | null {
  const text = value.trim();
  const rfc =
    /^(?:[a-z]{3},?\s+)?(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}:?\d{2}|[a-z]{1,4})?$/i.exec(
      text,
    );
  if (rfc !== null) {
    const [, d, mon, y, h, mi, s, zone] = rfc;
    const month = MONTHS[(mon ?? "").toLowerCase()];
    if (month === undefined) return null;
    let offset = DEFAULT_ZONE_MINUTES;
    if (zone !== undefined) {
      const numeric = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
      if (numeric !== null)
        offset =
          (numeric[1] === "-" ? -1 : 1) *
          (Number(numeric[2]) * 60 + Number(numeric[3]));
      else {
        const named = ZONES[zone.toUpperCase()];
        if (named === undefined) return null;
        offset = named;
      }
    }
    return (
      Date.UTC(
        Number(y),
        month,
        Number(d),
        Number(h),
        Number(mi),
        Number(s ?? "0"),
      ) -
      offset * 60_000
    );
  }
  // ISO 8601 with a zone; a bare ISO date-time is IST, as above.
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      text,
    );
  if (iso === null) return null;
  const [, y, mo, d, h, mi, s, zone] = iso;
  let offset = DEFAULT_ZONE_MINUTES;
  if (zone === "Z") offset = 0;
  else if (zone !== undefined) {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (m === null) return null;
    offset = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  }
  return (
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h),
      Number(mi),
      Number(s ?? "0"),
    ) -
    offset * 60_000
  );
}

/** CDATA stand-ins: private-use characters no feed text contains. */
const OPEN = String.fromCharCode(0xe000);
const CLOSE = String.fromCharCode(0xe001);
const PLACEHOLDER = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);

/** One child element's text: CDATA restored, entities decoded. */
function field(
  item: string,
  tag: string,
  cdata: readonly string[],
): string | null {
  // The opening tag must not be self-closing; attributes are allowed.
  const match = new RegExp(
    `<${tag}(?:\\s[^>]*[^/>])?\\s*>([\\s\\S]*?)</${tag}\\s*>`,
    "i",
  ).exec(item);
  if (match === null) return null;
  const restored = (match[1] ?? "").replace(
    PLACEHOLDER,
    (_, i: string) => cdata[Number(i)] ?? "",
  );
  const text = decodeEntities(restored);
  return text === "" ? null : text;
}

/**
 * Every `<item>` of an RSS 2.0 document that has a title and a link. Items
 * without either are skipped: a headline is its title and where it was read.
 */
export function parseRss(xml: string): RssItem[] {
  // CDATA first, out of the way: a description's HTML can hold anything,
  // including text that looks like `<link>` or `</item>`.
  const cdata: string[] = [];
  const body = xml
    .replace(BOM, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => {
      cdata.push(inner);
      return `${OPEN}${String(cdata.length - 1)}${CLOSE}`;
    })
    .replace(/<!--[\s\S]*?-->/g, "");
  const items: RssItem[] = [];
  for (const match of body.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = match[1] ?? "";
    const title = field(block, "title", cdata);
    const link = field(block, "link", cdata);
    if (title === null || link === null) continue;
    const date = field(block, "pubDate", cdata);
    items.push({
      title,
      link,
      publishedAt: date === null ? null : parseRssDate(date),
      guid: field(block, "guid", cdata),
    });
  }
  return items;
}
