import { describe, expect, it } from "vitest";

import {
  decodeHtmlEntitiesOnce,
  extractPlainTextFromHtml,
} from "../src/lib/html-plain-text.js";

const MAX_HTML_BYTES = 1_500_000;

function plainText(html: string, separator: " " | "\n" = " "): string {
  return extractPlainTextFromHtml(html, { separator });
}

describe("HTML plain-text extraction", () => {
  it("matches exact script and style elements without consuming similarly named custom elements", () => {
    const cases = [
      ["<script-menu>Visible menu</script-menu>", "Visible menu"],
      ["<style-guide>Visible menu</style-guide>", "Visible menu"],
      ["<script=menu>Visible menu</script=menu>", "Visible menu"],
      ["<style.menu>Visible menu</style.menu>", "Visible menu"],
      ["<scripture>Visible menu</scripture>", "Visible menu"],
      ["<ScRiPt>hidden()</sCrIpT><p>Visible menu</p>", "Visible menu"],
      ["<style media=\"screen\">.hidden { display: none }</style><p>Visible menu</p>", "Visible menu"],
    ] as const;

    for (const [html, expected] of cases) {
      expect(plainText(html)).toBe(expected);
    }
  });

  it("does not mistake non-delimiters for script or style closing-tag boundaries", () => {
    const cases = [
      "<script>hidden</script-x>FAKE BEER $10</script><p>Visible menu</p>",
      "<script>hidden</script:foo>FAKE BEER $10</script><p>Visible menu</p>",
      "<script>hidden</script=foo>FAKE BEER $10</script><p>Visible menu</p>",
      "<style>hidden</style.foo>FAKE BEER $10</style><p>Visible menu</p>",
      "<script>hidden</script\u0000foo>FAKE BEER $10</script><p>Visible menu</p>",
    ];

    for (const html of cases) {
      expect(plainText(html)).toBe("Visible menu");
    }
  });

  it("accepts browser-tolerated whitespace, attributes, and slash syntax on real closing tags", () => {
    const cases = [
      '<script src="menu.js">hidden</script foo="bar"><p>Visible menu</p>',
      "<script>hidden</script\t\n foo><p>Visible menu</p>",
      "<script>hidden</script/foo><p>Visible menu</p>",
      "<style>hidden</style media=screen><p>Visible menu</p>",
    ];

    for (const html of cases) {
      expect(plainText(html)).toBe("Visible menu");
    }
  });

  it("keeps unclosed raw-text element bodies out of visible text", () => {
    expect(plainText("<p>Before</p><script>FAKE BEER $10")).toBe("Before");
    expect(plainText("<p>Before</p><style>FAKE BEER $10")).toBe("Before");
  });

  it("follows escaped and double-escaped script tokenizer states", () => {
    const cases = [
      ["<script><!--hidden--></script><p>Visible menu</p>", "Visible menu"],
      ["<script><!--hidden</script foo=bar><p>Visible menu</p>", "Visible menu"],
      [
        "<script><!--<script>hidden</script>FAKE BEER $10</script><p>Visible menu</p>",
        "Visible menu",
      ],
      ["<script><!--<script>hidden</script><p>Not visible</p>", ""],
      ['<script>const value = "</script>";</script><p>Visible menu</p>', '"; Visible menu'],
    ] as const;

    for (const [html, expected] of cases) {
      expect(plainText(html)).toBe(expected);
    }
  });

  it("decodes one entity layer using HTML numeric and named-reference semantics", () => {
    const cases = [
      ["Fish &amp; Chips", "Fish & Chips"],
      ["&amp;lt;script&amp;gt;", "&lt;script&gt;"],
      ["&#38;lt;script&#38;gt;", "&lt;script&gt;"],
      ["&#x26;lt;script&#x26;gt;", "&lt;script&gt;"],
      ["A&#0;B", "A\uFFFDB"],
      ["A&#xD800;B", "A\uFFFDB"],
      ["A&#x110000;B", "A\uFFFDB"],
      ["Price &#128;10", "Price €10"],
      ["&#65 &#x42", "A B"],
      ["Fish &amp Chips", "Fish & Chips"],
      ["&apos;Pint&apos; &copy;", "'Pint' ©"],
      ["A &beer; B", "A &beer; B"],
      ["Beer &#x1F37A;", "Beer 🍺"],
    ] as const;

    for (const [value, expected] of cases) {
      expect(decodeHtmlEntitiesOnce(value)).toBe(expected);
    }
  });

  it("keeps entity-decoded angle brackets as literal text instead of reparsing them as tags", () => {
    expect(plainText("<p>&lt;script&gt;Carlton $10&lt;/script&gt;</p>"))
      .toBe("<script>Carlton $10</script>");
    expect(plainText("<p>&amp;lt;script&amp;gt;Carlton $10&amp;lt;/script&amp;gt;</p>"))
      .toBe("&lt;script&gt;Carlton $10&lt;/script&gt;");
  });

  it("supports collapsed-space and line-separator output modes", () => {
    const html = "<p>One&nbsp;Pint</p><p>Two<br>Three</p>";

    expect(plainText(html, " ")).toBe("One Pint Two Three");
    expect(plainText(html, "\n")).toBe("One Pint\nTwo\nThree");
  });

  it("removes foreign-content script nodes while preserving visible SVG text", () => {
    expect(plainText("<svg><script>FAKE BEER $10</script><text>Visible menu</text></svg>"))
      .toBe("Visible menu");
  });

  it("handles the maximum bounded HTML input without unmatched-script rescanning", { timeout: 5_000 }, () => {
    const visiblePrefix = "<p>Before</p>";
    const unmatchedOpening = "<script>";
    const remainingBytes = MAX_HTML_BYTES - Buffer.byteLength(visiblePrefix, "utf8");
    const repeatedOpenings = unmatchedOpening.repeat(Math.floor(remainingBytes / unmatchedOpening.length));
    const padding = "x".repeat(remainingBytes - Buffer.byteLength(repeatedOpenings, "utf8"));
    const html = `${visiblePrefix}${repeatedOpenings}${padding}`;

    expect(Buffer.byteLength(html, "utf8")).toBe(MAX_HTML_BYTES);
    expect(plainText(html)).toBe("Before");
  });

  it("walks deeply nested size-valid HTML without overflowing the call stack", () => {
    const depth = 12_000;
    const html = `${"<div>".repeat(depth)}Visible menu${"</div>".repeat(depth)}`;

    expect(Buffer.byteLength(html, "utf8")).toBeLessThan(MAX_HTML_BYTES);
    expect(plainText(html)).toBe("Visible menu");
  });
});
