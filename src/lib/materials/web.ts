import { lookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";

import { load } from "cheerio";
import { Agent, fetch } from "undici";
import { z } from "zod";

import { MAX_WEBSITE_REVISION_PAGES } from "@/lib/materials/contracts";

export type ResolveHostname = (hostname: string) => Promise<string[]>;

export type FetchedWebResource = {
  url: string;
  contentType: string;
  bytes: Buffer;
};

export type FetchWebResource = (
  url: string,
  options?: { maximumBytes?: number; requiredOrigin?: string },
) => Promise<FetchedWebResource>;

export type WebsiteDiscovery = {
  title: string;
  sourceUrl: string;
  pages: Array<{ title: string; url: string; level: number }>;
  preferredPdf: { title: string; url: string } | null;
  notice?: string;
};

export type ReadableWebPage = {
  title: string;
  text: string;
  headings: Array<{ level: number; text: string; anchor: string | null }>;
};

const DEFAULT_PAGE_FETCH_LIMIT = 5 * 1024 * 1024;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const openStaxCatalogSchema = z.object({
  books: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      high_resolution_pdf_url: z.string().nullable().optional(),
      low_resolution_pdf_url: z.string().nullable().optional(),
    }),
  ),
});

export async function validatePublicHttpsUrl(
  value: string,
  resolveHostname: ResolveHostname = resolvePublicAddresses,
): Promise<URL> {
  return (await resolveValidatedPublicHttpsUrl(value, resolveHostname)).url;
}

async function resolveValidatedPublicHttpsUrl(
  value: string,
  resolveHostname: ResolveHostname,
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter a valid website URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Website imports require an HTTPS URL.");
  }

  if (url.username || url.password) {
    throw new Error("Website URLs cannot contain credentials.");
  }

  if (!url.hostname || url.hostname === "localhost" || url.hostname.endsWith(".local")) {
    throw new Error("Website imports must use a public internet address.");
  }

  const addresses = isIP(url.hostname) ? [url.hostname] : await resolveHostname(url.hostname);

  if (addresses.length === 0 || addresses.some(isPrivateOrReservedAddress)) {
    throw new Error("Website imports must use a public internet address.");
  }

  url.hash = "";
  return { url, addresses };
}

export async function discoverBookWebsite(input: {
  url: string;
  maximumPages?: number;
  resolveHostname?: ResolveHostname;
  fetchResource?: FetchWebResource;
}): Promise<WebsiteDiscovery> {
  const resolveHostname = input.resolveHostname ?? resolvePublicAddresses;
  const requestedUrl = await validatePublicHttpsUrl(input.url, resolveHostname);
  const fetchResource =
    input.fetchResource ??
    ((url, options) =>
      fetchPublicWebResource(url, {
        ...options,
        resolveHostname,
      }));
  const resource = await fetchResource(requestedUrl.toString(), {
    maximumBytes: DEFAULT_PAGE_FETCH_LIMIT,
  });
  const finalUrl = await validatePublicHttpsUrl(resource.url, resolveHostname);

  if (!resource.contentType.toLowerCase().includes("text/html")) {
    throw new Error("That URL did not return a readable HTML textbook page.");
  }

  const html = resource.bytes.toString("utf8");
  const $ = load(html);
  const title = cleanText($("title").first().text()) || cleanText($("h1").first().text()) || finalUrl.hostname;
  const openStaxHandoff = await discoverOpenStaxPdfHandoff({
    url: finalUrl,
    fetchResource,
    resolveHostname,
  });
  if (openStaxHandoff) {
    return openStaxHandoff;
  }
  const maximumPages = Math.max(
    1,
    Math.min(input.maximumPages ?? MAX_WEBSITE_REVISION_PAGES, MAX_WEBSITE_REVISION_PAGES),
  );
  const seen = new Set<string>();
  const pages: WebsiteDiscovery["pages"] = [];
  const navigation = $(
    'nav[aria-label*="content" i], nav[aria-label*="chapter" i], .toc, #toc, [role="navigation"], nav',
  ).first();
  const candidateLinks = navigation.length ? navigation.find("a[href]") : $("main a[href], article a[href]");

  candidateLinks.each((_, element) => {
    if (pages.length >= maximumPages) {
      return false;
    }

    const href = $(element).attr("href");
    if (!href) {
      return;
    }

    const url = normalizeSameOriginUrl(href, finalUrl);
    if (!url || seen.has(url) || looksLikePdf(url)) {
      return;
    }

    const linkTitle = cleanText($(element).text()) || titleFromUrl(url);
    if (!linkTitle || isUtilityNavigationLabel(linkTitle)) {
      return;
    }

    seen.add(url);
    pages.push({
      title: linkTitle,
      url,
      level: Math.max(1, Math.min($(element).parents("li").length, 6)),
    });
  });

  const preferredPdf = findPreferredPdf($, finalUrl);

  if (pages.length === 0) {
    try {
      extractReadableWebPage(html, title);
    } catch {
      throw new Error(
        "That website appears to be JavaScript-only and did not expose readable textbook pages.",
      );
    }
    pages.push({ title, url: finalUrl.toString(), level: 1 });
  }

  return {
    title,
    sourceUrl: finalUrl.toString(),
    pages,
    preferredPdf,
  };
}

async function discoverOpenStaxPdfHandoff(input: {
  url: URL;
  fetchResource: FetchWebResource;
  resolveHostname: ResolveHostname;
}): Promise<WebsiteDiscovery | null> {
  if (input.url.hostname !== "openstax.org") {
    return null;
  }

  const match = input.url.pathname.match(/^\/details\/books\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }

  const slug = decodeURIComponent(match[1]);
  const catalogUrl = new URL("/apps/cms/api/books/?format=json", input.url);
  const resource = await input.fetchResource(catalogUrl.toString(), {
    maximumBytes: DEFAULT_PAGE_FETCH_LIMIT,
    requiredOrigin: input.url.origin,
  });
  const finalCatalogUrl = await validatePublicHttpsUrl(resource.url, input.resolveHostname);
  if (finalCatalogUrl.origin !== input.url.origin) {
    throw new Error("OpenStax catalog discovery left the expected origin.");
  }

  let catalog: z.infer<typeof openStaxCatalogSchema>;
  try {
    catalog = openStaxCatalogSchema.parse(JSON.parse(resource.bytes.toString("utf8")));
  } catch {
    throw new Error("OpenStax did not return readable textbook metadata.");
  }

  const book = catalog.books.find((candidate) => candidate.slug === `books/${slug}`);
  const pdfValue = book?.low_resolution_pdf_url || book?.high_resolution_pdf_url;
  if (!book || !pdfValue) {
    throw new Error(
      "This OpenStax page uses a JavaScript-only reader and did not provide a downloadable PDF.",
    );
  }

  const pdfUrl = await validatePublicHttpsUrl(pdfValue, input.resolveHostname);
  if (!looksLikePdf(pdfUrl.toString())) {
    throw new Error("OpenStax returned an unsupported textbook download.");
  }

  return {
    title: book.title,
    sourceUrl: input.url.toString(),
    pages: [],
    preferredPdf: {
      title: `Download ${book.title} PDF`,
      url: pdfUrl.toString(),
    },
    notice:
      "OpenStax exposes this textbook through a dynamic reader. Use its official PDF for complete, stable page references.",
  };
}

export async function fetchPublicWebResource(
  inputUrl: string,
  options: {
    maximumBytes?: number;
    requiredOrigin?: string;
    resolveHostname?: ResolveHostname;
  } = {},
): Promise<FetchedWebResource> {
  const resolveHostname = options.resolveHostname ?? resolvePublicAddresses;
  const maximumBytes = options.maximumBytes ?? DEFAULT_PAGE_FETCH_LIMIT;
  let currentValue = inputUrl;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const resolved = await resolveValidatedPublicHttpsUrl(currentValue, resolveHostname);
    const current = resolved.url;
    if (options.requiredOrigin && current.origin !== options.requiredOrigin) {
      throw new Error("Website imports can only follow pages from the same origin.");
    }

    const dispatcher = createPinnedPublicAgent(resolved.addresses);
    try {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        dispatcher,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/json,application/pdf;q=0.9",
          "User-Agent": "LearnRecur material importer/1.0",
        },
        signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === MAX_REDIRECTS) {
          throw new Error("Website import followed too many redirects.");
        }

        await response.body?.cancel();
        currentValue = new URL(location, current).toString();
        continue;
      }

      if (!response.ok) {
        throw new Error(`Website import failed with HTTP ${response.status}.`);
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error("Website page exceeded the import byte limit.");
      }

      return {
        url: current.toString(),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        bytes: await readResponseBytes(response.body, maximumBytes),
      };
    } finally {
      await dispatcher.close();
    }
  }

  throw new Error("Website import followed too many redirects.");
}

function createPinnedPublicAgent(addresses: string[]) {
  const records = addresses.map((address) => ({ address, family: isIP(address) }));
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    const requestedFamily = typeof options.family === "number" ? options.family : 0;
    const eligible = requestedFamily
      ? records.filter((record) => record.family === requestedFamily)
      : records;
    if (eligible.length === 0) {
      const error = Object.assign(new Error("No validated address matched the requested family."), {
        code: "ENOTFOUND",
      }) as NodeJS.ErrnoException;
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(null, eligible);
      return;
    }
    callback(null, eligible[0].address, eligible[0].family);
  };

  return new Agent({ connect: { lookup: pinnedLookup } });
}

export function extractReadableWebPage(html: string, fallbackTitle: string): ReadableWebPage {
  const $ = load(html);
  $("script, style, noscript, template, iframe, form, nav, footer, header, aside").remove();
  const root = $("main").first().length
    ? $("main").first()
    : $("article").first().length
      ? $("article").first()
      : $("body").first();
  const title = cleanText($("h1").first().text()) || cleanText($("title").first().text()) || fallbackTitle;
  const headings = root
    .find("h1, h2, h3, h4, h5, h6")
    .toArray()
    .map((element) => ({
      level: Number(element.tagName.slice(1)),
      text: cleanText($(element).text()),
      anchor: $(element).attr("id")?.trim() || null,
    }))
    .filter((heading) => heading.text);
  const text = cleanText(root.text());

  if (text.length < 80) {
    throw new Error("A selected website page did not contain enough readable text.");
  }

  return { title, text, headings };
}

async function resolvePublicAddresses(hostname: string) {
  return (await lookup(hostname, { all: true, verbatim: true })).map((result) => result.address);
}

function isPrivateOrReservedAddress(address: string) {
  const normalized = address.toLowerCase().split("%")[0];

  if (normalized.startsWith("::ffff:")) {
    return isPrivateOrReservedAddress(normalized.slice("::ffff:".length));
  }

  if (isIP(normalized) === 4) {
    const [a, b] = normalized.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("2001:db8:")
    );
  }

  return true;
}

async function readResponseBytes(body: AsyncIterable<Uint8Array> | null, maximumBytes: number) {
  if (!body) {
    return Buffer.alloc(0);
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const value of body) {
    total += value.byteLength;
    if (total > maximumBytes) {
      throw new Error("Website page exceeded the import byte limit.");
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

function normalizeSameOriginUrl(href: string, base: URL) {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.origin !== base.origin || url.username || url.password) {
    return null;
  }

  url.hash = "";
  return url.toString();
}

function findPreferredPdf($: ReturnType<typeof load>, base: URL) {
  let preferred: WebsiteDiscovery["preferredPdf"] = null;

  $("a[href]").each((_, element) => {
    if (preferred) {
      return false;
    }

    const href = $(element).attr("href");
    if (!href) {
      return;
    }
    const url = normalizeSameOriginUrl(href, base);
    if (!url || !looksLikePdf(url)) {
      return;
    }

    preferred = {
      title: cleanText($(element).text()) || "Download PDF",
      url,
    };
  });

  return preferred;
}

function looksLikePdf(url: string) {
  return new URL(url).pathname.toLowerCase().endsWith(".pdf");
}

function cleanText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function titleFromUrl(value: string) {
  const segment = new URL(value).pathname.split("/").filter(Boolean).at(-1) ?? "Page";
  return decodeURIComponent(segment).replace(/[-_]+/g, " ").trim();
}

function isUtilityNavigationLabel(value: string) {
  return /^(home|next|previous|back|top|menu|search|sign in|log in)$/i.test(value);
}
