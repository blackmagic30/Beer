const SCRIPT_ELEMENT_PATTERN = /<script\b[^>]*>[\s\S]*?<\/script\b[^>]*>/gi;
const STYLE_ELEMENT_PATTERN = /<style\b[^>]*>[\s\S]*?<\/style\b[^>]*>/gi;
const HTML_ENTITY_PATTERN =
  /&(?:nbsp|ndash|mdash|middot|bull|quot|#39|lt|gt|amp|#x[0-9a-f]+|#[0-9]+);/gi;
const NAMED_HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  middot: " ",
  bull: " ",
  quot: '"',
  lt: "<",
  gt: ">",
  amp: "&",
};

/**
 * Decodes one entity layer. A replacement is never scanned again, so nested
 * input such as `&#38;lt;script&#38;gt;` remains encoded as `&lt;script&gt;`
 * rather than becoming markup.
 */
export function decodeHtmlEntitiesOnce(value: string): string {
  return value.replace(HTML_ENTITY_PATTERN, (entity) => {
    const body = entity.slice(1, -1).toLowerCase();
    if (body.startsWith("#")) {
      const hexadecimal = body.startsWith("#x");
      const codePoint = Number.parseInt(body.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (
        !Number.isInteger(codePoint) ||
        codePoint < 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return entity;
      }
      return String.fromCodePoint(codePoint);
    }
    return NAMED_HTML_ENTITIES[body] ?? entity;
  });
}

/**
 * Removes executable and styling elements before HTML is reduced to plain text.
 *
 * HTML parsers accept attributes and whitespace on malformed closing tags, so
 * the closing-tag side deliberately consumes everything up to the next `>`.
 * The returned value is still plain-text input and must not be rendered as
 * trusted HTML.
 */
export function removeNonTextHtmlElements(value: string): string {
  return value
    .replace(SCRIPT_ELEMENT_PATTERN, " ")
    .replace(STYLE_ELEMENT_PATTERN, " ");
}
