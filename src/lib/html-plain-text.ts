import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";

const BLOCK_ELEMENTS = new Set([
  "article",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "p",
  "section",
  "table",
  "td",
  "th",
  "tr",
]);

export interface HtmlPlainTextOptions {
  separator?: " " | "\n";
}

function appendTextContent(node: DefaultTreeAdapterTypes.Node, output: string[]): void {
  const pending: DefaultTreeAdapterTypes.Node[] = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    if ("value" in current) {
      output.push(current.value);
      continue;
    }
    if (!("childNodes" in current)) {
      continue;
    }

    const childContainer = "content" in current ? current.content : current;
    for (let index = childContainer.childNodes.length - 1; index >= 0; index -= 1) {
      const child = childContainer.childNodes[index];
      if (child) {
        pending.push(child);
      }
    }
  }
}

/**
 * Decodes one HTML character-reference layer without interpreting decoded or
 * literal angle brackets as markup.
 */
export function decodeHtmlEntitiesOnce(value: string): string {
  const fragment = parseFragment(value.replaceAll("<", "&lt;"));
  const output: string[] = [];
  appendTextContent(fragment, output);
  return output.join("");
}

function appendPlainText(
  node: DefaultTreeAdapterTypes.Node,
  separator: " " | "\n",
  output: string[],
): void {
  type TraversalFrame =
    | { kind: "node"; node: DefaultTreeAdapterTypes.Node }
    | { kind: "close"; tagName: string };

  const pending: TraversalFrame[] = [{ kind: "node", node }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (!frame) {
      continue;
    }
    if (frame.kind === "close") {
      output.push(separator === "\n" && BLOCK_ELEMENTS.has(frame.tagName) ? "\n" : " ");
      continue;
    }

    const current = frame.node;
    if ("value" in current) {
      output.push(current.value);
      continue;
    }
    if (!("childNodes" in current)) {
      output.push(" ");
      continue;
    }
    if (!("tagName" in current)) {
      for (let index = current.childNodes.length - 1; index >= 0; index -= 1) {
        const child = current.childNodes[index];
        if (child) {
          pending.push({ kind: "node", node: child });
        }
      }
      continue;
    }

    const tagName = current.tagName.toLowerCase();
    if (tagName === "script" || tagName === "style") {
      output.push(" ");
      continue;
    }
    if (tagName === "br") {
      output.push(separator);
      continue;
    }

    output.push(" ");
    pending.push({ kind: "close", tagName });
    const childContainer = "content" in current ? current.content : current;
    for (let index = childContainer.childNodes.length - 1; index >= 0; index -= 1) {
      const child = childContainer.childNodes[index];
      if (child) {
        pending.push({ kind: "node", node: child });
      }
    }
  }
}

/**
 * Extracts text with a standards-compliant HTML parser. Actual script and style
 * subtrees are skipped; character references are decoded once by the tokenizer
 * and their decoded values are never parsed again as markup.
 */
export function extractPlainTextFromHtml(
  value: string,
  options: HtmlPlainTextOptions = {},
): string {
  const separator = options.separator ?? " ";
  const fragment = parseFragment(value);
  const output: string[] = [];
  appendPlainText(fragment, separator, output);

  const text = output.join("");
  if (separator === " ") {
    return text.replace(/\s+/g, " ").trim();
  }

  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
