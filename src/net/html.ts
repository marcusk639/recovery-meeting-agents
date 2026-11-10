import * as cheerio from "cheerio";

/**
 * Readable text for an extractor, keeping link targets inline so a conference
 * link in an href can be quoted and checked against the page.
 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, template, svg, iframe, head").remove();
  $("a[href]").each((_, element) => {
    const anchor = $(element);
    const href = anchor.attr("href")?.trim();
    if (href && /^https?:/i.test(href)) {
      anchor.append(` (${href})`);
    }
  });
  $("br, p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article, table").each(
    (_, element) => {
      $(element).append("\n");
    },
  );
  $("td, th").each((_, element) => {
    $(element).append(" | ");
  });
  return $.root()
    .text()
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
