import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

export interface ExtractedContent {
  title: string;
  content: string;
  author: string | null;
  published_at: string | null;
  language: string;
  word_count: number;
}

const FETCH_TIMEOUT_MS = 30_000;
const USER_AGENT = "vega-memory/0.1 content-ingestion";
const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
const WORD_PATTERN = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]|[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/g;

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'");

const stripTags = (value: string): string => value.replace(/<[^>]+>/g, " ");

const normalizeWhitespace = (value: string): string =>
  value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const normalizeMarkdown = (value: string): string => {
  const sections = value.split(/(__CODE_BLOCK_\d+__)/g);

  return normalizeWhitespace(
    sections
      .map((section) => {
        if (/^__CODE_BLOCK_\d+__$/.test(section)) {
          return section;
        }

        return section
          .split("\n")
          .map((line) => {
            const trimmed = line.trim();
            if (trimmed.length === 0) {
              return "";
            }

            if (/^#{1,6}\s/.test(trimmed)) {
              const match = /^(#{1,6})\s*(.*)$/.exec(trimmed);
              return match ? `${match[1]} ${match[2].replace(/\s+/g, " ").trim()}` : trimmed;
            }

            if (/^- /.test(trimmed)) {
              return `- ${trimmed.slice(2).replace(/\s+/g, " ").trim()}`;
            }

            return trimmed.replace(/\s+/g, " ");
          })
          .join("\n");
      })
      .join("")
  );
};

const buildTitleFromFilename = (filePath: string): string => {
  const fileName = basename(filePath, extname(filePath));
  const normalized = fileName.replace(/[_-]+/g, " ").trim();
  return normalized.length > 0 ? normalized : "Untitled File";
};

const toAbsoluteUrl = (href: string, baseUrl: string): string => {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href.trim();
  }
};

const fetchWithTimeout = async (input: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
};

const extractFirstMatch = (value: string, pattern: RegExp): string | null => {
  const match = pattern.exec(value);
  return match?.[1]?.trim() || null;
};

const extractMetaContent = (html: string, names: string[]): string | null => {
  for (const name of names) {
    const pattern = new RegExp(
      `<meta[^>]+(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i"
    );
    const value = extractFirstMatch(html, pattern);
    if (value) {
      return decodeHtmlEntities(value);
    }
  }

  return null;
};

const stripElements = (html: string): string =>
  html.replace(/<(script|style|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

const pickSection = (html: string): string => {
  const article = extractFirstMatch(html, /<article\b[^>]*>([\s\S]*?)<\/article>/i);
  if (article) {
    return article;
  }

  const main = extractFirstMatch(html, /<main\b[^>]*>([\s\S]*?)<\/main>/i);
  if (main) {
    return main;
  }

  const body = extractFirstMatch(html, /<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ?? html;
};

const htmlToMarkdown = (html: string, baseUrl: string): string => {
  const codeBlocks: string[] = [];
  let transformed = html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    const code = decodeHtmlEntities(stripTags(inner)).replace(/^\s+|\s+$/g, "");
    const token = `__CODE_BLOCK_${codeBlocks.length}__`;
    codeBlocks.push(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
    return token;
  });

  transformed = transformed.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => {
    const value = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    return value.length > 0 ? `\`${value}\`` : "";
  });

  transformed = transformed.replace(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, inner: string) => {
      const text = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
      const target = toAbsoluteUrl(href, baseUrl);
      return text.length > 0 ? `[${text}](${target})` : target;
    }
  );

  for (let level = 6; level >= 1; level -= 1) {
    const pattern = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi");
    transformed = transformed.replace(pattern, (_, inner: string) => {
      const text = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
      return text.length > 0 ? `\n\n${"#".repeat(level)} ${text}\n\n` : "";
    });
  }

  transformed = transformed.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner: string) => {
    const text = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    return text.length > 0 ? `\n- ${text}\n` : "";
  });

  transformed = transformed.replace(/<br\s*\/?>/gi, "\n");
  transformed = transformed.replace(/<\/(p|div|section|article|main|blockquote|ul|ol)>/gi, "\n\n");
  transformed = transformed.replace(/<(p|div|section|article|main|blockquote|ul|ol)\b[^>]*>/gi, "\n\n");
  transformed = decodeHtmlEntities(stripTags(transformed));
  transformed = normalizeMarkdown(transformed);

  return codeBlocks.reduce(
    (content, block, index) => content.replace(`__CODE_BLOCK_${index}__`, block.trim()),
    transformed
  );
};

const detectLanguage = (content: string): string => {
  const nonWhitespaceLength = content.replace(/\s/g, "").length;
  if (nonWhitespaceLength === 0) {
    return "en";
  }

  const cjkCount = content.match(CJK_PATTERN)?.length ?? 0;
  return cjkCount / nonWhitespaceLength > 0.3 ? "zh" : "en";
};

const countWords = (content: string): number => content.match(WORD_PATTERN)?.length ?? 0;

const extractTitle = (html: string, section: string): string => {
  const title =
    extractFirstMatch(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i) ??
    extractFirstMatch(section, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ??
    extractFirstMatch(html, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i);

  const normalized = title ? decodeHtmlEntities(stripTags(title)).replace(/\s+/g, " ").trim() : "";
  return normalized.length > 0 ? normalized : "Untitled";
};

const parsePublishedAt = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

export class ContentFetcher {
  async fetchUrl(url: string): Promise<ExtractedContent> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`);
    }

    const response = await fetchWithTimeout(
      parsedUrl.toString(),
      {
        headers: {
          "user-agent": USER_AGENT
        }
      },
      FETCH_TIMEOUT_MS
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Failed to fetch URL ${parsedUrl.toString()} with status ${response.status}${detail ? `: ${detail}` : ""}`
      );
    }

    const html = await response.text();
    const stripped = stripElements(html);
    const section = pickSection(stripped);
    const title = extractTitle(stripped, section);
    const content = htmlToMarkdown(section, parsedUrl.toString());
    const language = detectLanguage(content);

    return {
      title,
      content,
      author: extractMetaContent(html, ["author", "article:author"]),
      published_at: parsePublishedAt(
        extractMetaContent(html, [
          "article:published_time",
          "og:published_time",
          "datePublished",
          "pubdate"
        ])
      ),
      language,
      word_count: countWords(content)
    };
  }

  async fetchFile(filePath: string): Promise<ExtractedContent> {
    const raw = await readFile(filePath, "utf8");
    const extension = extname(filePath).toLowerCase();
    const title = buildTitleFromFilename(filePath);
    const content =
      extension === ".html" || extension === ".htm"
        ? htmlToMarkdown(stripElements(raw), `file://${filePath}`)
        : normalizeWhitespace(raw);
    const language = detectLanguage(content);

    return {
      title,
      content,
      author: null,
      published_at: null,
      language,
      word_count: countWords(content)
    };
  }

  async readClipboard(): Promise<string> {
    const commands =
      process.platform === "darwin"
        ? ["pbpaste"]
        : process.platform === "win32"
          ? ['powershell.exe -command "Get-Clipboard"']
          : ["xclip -selection clipboard -o", "xsel --clipboard --output"];

    for (const command of commands) {
      try {
        const output = execSync(command, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"]
        });
        return output;
      } catch {
        continue;
      }
    }

    throw new Error(`Clipboard read is not available on platform ${process.platform}`);
  }
}
