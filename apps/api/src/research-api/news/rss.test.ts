import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeEntities, parseRss, parseRssDate } from "./rss.js";

/**
 * The fixtures are real items, copied verbatim from each feed on 2026-11-28
 * (channel header, a few items, closing tags) — the parser is tested against
 * what the sites actually send, not against what RSS 2.0 says they should.
 */
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const iso = (ms: number | null): string | null =>
  ms === null ? null : new Date(ms).toISOString();

describe("parseRss on the real feeds", () => {
  it("Economic Times: CDATA titles with entities encoded twice", () => {
    const items = parseRss(fixture("et-markets.xml"));
    expect(items).toHaveLength(5);
    expect(items[0]).toEqual({
      title: "Bond market to stay cautious ahead of RBI policy: Equirus",
      link: "https://economictimes.indiatimes.com/markets/bonds/bond-market-to-stay-cautious-ahead-of-rbi-policy-equirus/articleshow/136240295.cms",
      publishedAt: Date.parse("2026-11-28T06:13:58Z"), // 11:43:58 +0530
      guid: "https://economictimes.indiatimes.com/markets/bonds/bond-market-to-stay-cautious-ahead-of-rbi-policy-equirus/articleshow/136240295.cms",
    });
    // `M&amp;amp;M` inside CDATA is the company M&M.
    expect(items[3]?.title).toBe(
      "M&M Share Price Highlights: M&M Stock Price History",
    );
    expect(items[4]?.title).toBe(
      "L&T Share Price Highlights: L&T Stock Price History",
    );
    expect(parseRss(fixture("et-stocks.xml")).map((i) => i.title)).toEqual([
      "RIL Share Price Live Updates: RIL Stock Price History",
      "SBI Life Share Price Highlights: SBI Life Stock Price History",
      "HDFC Life Share Price Highlights: HDFC Life Stock Price History",
      "Jio Financial Services Share Price Highlights: Jio Financial Services Stock Price History",
      "ICICI Bank Share Price Highlights: ICICI Bank Stock Price History",
      "SBI Share Price Highlights: SBI Stock Price History",
    ]);
  });

  it("Livemint: CDATA around the link and the date too", () => {
    const items = parseRss(fixture("livemint.xml"));
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({
      title:
        "After an 85% surge in 6 months, HSBC sees another 28% upside in jewellery stock Kalyan Jewellers; up 878% in 5 years",
      link: "https://www.livemint.com/market/stock-market-news/after-an-85-surge-in-6-months-hsbc-sees-another-28-upside-in-jewellery-stock-kalyan-jewellers-up-878-in-5-years-11795857586886.html",
      publishedAt: Date.parse("2026-11-28T10:48:58Z"), // 16:18:58 +0530
      guid: "https://www.livemint.com/market/stock-market-news/after-an-85-surge-in-6-months-hsbc-sees-another-28-upside-in-jewellery-stock-kalyan-jewellers-up-878-in-5-years-11795857586886.html",
    });
  });

  it("RBI: a byte-order mark, HTML descriptions, no guid, dates without a zone read as IST", () => {
    const items = parseRss(fixture("rbi.xml"));
    expect(items).toEqual([
      {
        title:
          "RBI to conduct Overnight Variable Rate Repo (VRR) auction under LAF on November 30, 2026",
        link: "https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=64061",
        publishedAt: Date.parse("2026-11-27T14:15:00Z"), // 19:45:00 IST, written bare
        guid: null,
      },
      {
        title: "Auction of State Government Securities",
        link: "https://www.rbi.org.in/scripts/BS_PressReleaseDisplay.aspx?prid=64060",
        publishedAt: Date.parse("2026-11-27T13:30:00Z"),
        guid: null,
      },
    ]);
  });

  it("Google News: plain-text titles with the publisher, GMT dates, the article link as given", () => {
    const items = parseRss(fixture("gnews.xml"));
    expect(items).toHaveLength(3);
    expect(items[0]?.title).toBe(
      "HDFC Bank UPI SMS alert changes from January 1, 2027: Bank won’t send alerts for these UPI transactions - The Economic Times",
    );
    expect(items[0]?.link).toMatch(
      /^https:\/\/news\.google\.com\/rss\/articles\/CBMi[\w-]+\?oc=5$/,
    );
    expect(iso(items[0]?.publishedAt ?? null)).toBe("2026-11-28T05:47:28.000Z");
    expect(items[1]?.title).toBe(
      "HDFC Bank Share Price - Live NSE: HDFCBANK Stock Price & Chart - Upstox",
    );
    expect(items[1]?.guid).toMatch(/^CBMi/);
  });
});

describe("parseRss on awkward input", () => {
  it("is not fooled by tags inside CDATA, comments or self-closing links", () => {
    const xml = `<?xml version="1.0"?><rss><channel><atom:link href="x"/>
      <item>
        <description><![CDATA[<p>see <link>https://bad.example/</link></p></item><item>]]></description>
        <!-- <title>commented out</title> -->
        <title>Real &amp; true</title>
        <link>https://good.example/a?utm_source=x</link>
        <pubDate>Mon, 30 Nov 2026 09:00:00 GMT</pubDate>
      </item>
      <item><title>No link</title></item>
      <item><link href="https://atom.example/"/><title>Atom-style link only</title></item>
    </channel></rss>`;
    expect(parseRss(xml)).toEqual([
      {
        title: "Real & true",
        link: "https://good.example/a?utm_source=x",
        publishedAt: Date.parse("2026-11-30T09:00:00Z"),
        guid: null,
      },
    ]);
  });

  it("keeps an item whose date does not parse, with no date", () => {
    const xml =
      "<rss><channel><item><title>t</title><link>https://x.example/</link><pubDate>someday</pubDate></item></channel></rss>";
    expect(parseRss(xml)[0]?.publishedAt).toBeNull();
  });
});

describe("decodeEntities", () => {
  it("decodes named and numeric entities, twice at most, and collapses whitespace", () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(decodeEntities("M&amp;amp;M")).toBe("M&M");
    expect(decodeEntities("a &lt;b&gt; &quot;c&quot; &#39;d&#x27;")).toBe(
      "a <b> \"c\" 'd'",
    );
    expect(decodeEntities(`  under${nbsp}${nbsp}&#8377;200 &nbsp; now  `)).toBe(
      `under ${String.fromCodePoint(0x20b9)}200 now`,
    );
    expect(decodeEntities("&rsquo;&hellip;&unknown;")).toBe(
      `${String.fromCodePoint(0x2019, 0x2026)}&unknown;`,
    );
  });
});

describe("parseRssDate", () => {
  it("reads RFC 822 with offsets and zone names, and ISO 8601", () => {
    expect(iso(parseRssDate("Sat, 28 Nov 2026 16:18:58 +0530"))).toBe(
      "2026-11-28T10:48:58.000Z",
    );
    expect(iso(parseRssDate("Fri, 27 Nov 2026 16:17:07 GMT"))).toBe(
      "2026-11-27T16:17:07.000Z",
    );
    expect(iso(parseRssDate("27 Nov 2026 11:00 EST"))).toBe(
      "2026-11-27T16:00:00.000Z",
    );
    expect(iso(parseRssDate("2026-11-27T19:45:00Z"))).toBe(
      "2026-11-27T19:45:00.000Z",
    );
    expect(iso(parseRssDate("2026-11-27T19:45:00+05:30"))).toBe(
      "2026-11-27T14:15:00.000Z",
    );
  });

  it("reads a date without a zone as IST, whatever the machine's clock", () => {
    expect(iso(parseRssDate("Fri, 27 Nov 2026 20:45:00"))).toBe(
      "2026-11-27T15:15:00.000Z",
    );
    expect(iso(parseRssDate("2026-11-27T20:45:00"))).toBe(
      "2026-11-27T15:15:00.000Z",
    );
  });

  it("refuses what it cannot read", () => {
    expect(parseRssDate("")).toBeNull();
    expect(parseRssDate("Fri, 27 Foo 2026 20:45:00")).toBeNull();
    expect(parseRssDate("Fri, 27 Nov 2026 20:45:00 XYZT")).toBeNull();
  });
});
