// Parses st/1 text or st-json/1 NDJSON in errors-ai.log into reports. Pure — no vscode
// dependency — so it is unit-testable headless. Mirrors the IntelliJ plugin's text parser:
// tolerant of unknown lines (forward compatibility per the st/1 spec), of the
// self-describing file header (which quotes the delimiter mid-line inside a '#' comment),
// and of truncated/rotated files.

export interface StFrame {
  /** The source file name as written in the frame, e.g. "PaymentService.java". */
  file: string;
  line: number;
  /** The full trimmed frame line, for the tooltip. */
  text: string;
}

export interface StReport {
  id: string;
  timestamp: string;
  headline: string;
  culprit?: StFrame;
  frames: StFrame[];
  /** The full report block, verbatim — what "Copy report for AI" copies. */
  block: string;
}

const START = "━━━ ERROR #";
const END = "━━━ END #";
// id + timestamp from "━━━ ERROR #a1b2 ━━━ 2026-07-10 20:16:40.412 thread=… ━━━"
const HEADER = /^━━━ ERROR #(\S+) ━━━ (.+?) thread=/;
// A frame carrying a source location: "…(PaymentService.java:44)".
//
// The file part accepts anything that isn't whitespace, a colon or a paren, so Unicode
// source names (`Ação.java`) match — `\w` is ASCII-only in JS without the `u` flag, and a
// frame that doesn't match leaves the report with no culprit at all.
//
// `kts` is listed before `kt` on purpose: with `kt` first the engine matches `.kt`, then
// needs `:` and finds `s`, and the whole frame fails to parse.
//
// The line number allows a leading `-`. The JVM writes -1 for a class compiled without
// `-g:lines` and -2 for a native method, and the library renders it verbatim.
const FRAME = /\(([^\s:()]+\.(?:java|kts|kt|groovy|scala)):(-?\d+)\)/;

export function parseReports(content: string): StReport[] {
  if (!content) {
    return [];
  }

  const firstEntry = content
    .split("\n")
    .map(stripCr)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith("#"));

  return firstEntry?.startsWith("{") ? parseJsonReports(content) : parseTextReports(content);
}

function parseTextReports(content: string): StReport[] {
  const reports: StReport[] = [];
  const lines = content.split("\n").map(stripCr);
  let i = 0;
  while (i < lines.length) {
    // a real report starts with the delimiter at column 0; the header only quotes it mid-line
    if (!lines[i].startsWith(START)) {
      i++;
      continue;
    }
    const block: string[] = [lines[i]];
    let complete = false;
    let j = i + 1;
    while (j < lines.length) {
      const bl = lines[j];
      if (bl.startsWith(START)) {
        break; // next block began — this one was truncated
      }
      block.push(bl);
      if (bl.startsWith(END)) {
        complete = true;
        j++;
        break;
      }
      j++;
    }
    // FORMAT.md: a block whose closing line is absent is incomplete and MUST be discarded
    // rather than shown as a partial entry. The writer appends the block separately from
    // the header, so a read can land mid-write and catch exactly this.
    if (complete) {
      const report = parseBlock(block);
      if (report) {
        reports.push(report);
      }
    }
    i = j;
  }
  return reports;
}

function parseJsonReports(content: string): StReport[] {
  const reports: StReport[] = [];
  for (const rawLine of content.split("\n")) {
    const line = stripCr(rawLine).trim();
    if (!line) {
      continue;
    }

    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // torn/half-written lines must not abort the rest of the file
    }

    const report = parseJsonReport(entry);
    if (report) {
      reports.push(report);
    }
  }
  return reports;
}

function parseJsonReport(entry: unknown): StReport | undefined {
  if (!isObject(entry) || entry.type !== "report") {
    return undefined;
  }

  const id = stringValue(entry.id);
  if (!id) {
    return undefined;
  }

  const timestamp = jsonTimestamp(stringValue(entry.ts));
  const error = isObject(entry.error) ? entry.error : {};
  const headline = jsonHeadline(error);
  const frames: StFrame[] = [];

  let culprit: StFrame | undefined;
  const culpritValue = isObject(error.culprit) ? error.culprit : undefined;
  if (culpritValue) {
    const frameText = stringValue(culpritValue.frame);
    const text = culpritValue.appCode === true ? `${frameText} ← YOUR CODE` : frameText;
    culprit = parseFrame(text);
    if (culprit) {
      frames.push(culprit);
    }
  }

  if (Array.isArray(error.wrappedBy)) {
    for (const value of error.wrappedBy) {
      if (typeof value !== "string") {
        continue;
      }
      const frame = parseFrame(value);
      if (frame) {
        frames.push(frame);
      }
    }
  }

  const stack = isObject(entry.stack) ? entry.stack : undefined;
  if (stack && Array.isArray(stack.frames)) {
    for (const value of stack.frames) {
      if (typeof value !== "string") {
        continue;
      }
      const frame = parseFrame(value);
      if (frame) {
        frames.push(frame);
      }
    }
  }

  return {
    id,
    timestamp,
    headline,
    culprit,
    frames: framesWithoutDuplicateCulprit(culprit, frames),
    block: JSON.stringify(entry, null, 2) + "\n",
  };
}

function jsonHeadline(error: Record<string, unknown>): string {
  const message = stringValue(error.message);
  if (error.noException === true) {
    return `ERROR (no exception): ${message}`;
  }
  const type = stringValue(error.type);
  return message ? `${type}: ${message}` : type;
}

function jsonTimestamp(timestamp: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}\.\d{3})(?:Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  return match ? `${match[1]} ${match[2]}` : timestamp;
}

function parseFrame(text: string): StFrame | undefined {
  const match = FRAME.exec(text);
  if (!match) {
    return undefined;
  }
  const line = parseInt(match[2], 10);
  return line > 0 ? { file: match[1], line, text: text.trim() } : undefined;
}

function framesWithoutDuplicateCulprit(
  culprit: StFrame | undefined,
  frames: StFrame[],
): StFrame[] {
  if (!culprit) {
    return frames;
  }

  return [
    culprit,
    ...frames.filter(
      (frame) =>
        frame.file !== culprit.file || frame.line !== culprit.line,
    ),
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseBlock(block: string[]): StReport | undefined {
  const header = HEADER.exec(block[0]);
  if (!header) {
    return undefined;
  }
  const id = header[1];
  const timestamp = header[2].trim();
  const headline = block.length > 1 ? block[1].trim() : "";

  let culprit: StFrame | undefined;
  let markedFrameSeen = false;
  const frames: StFrame[] = [];
  for (const bl of block) {
    const fm = FRAME.exec(bl);
    if (!fm) {
      continue;
    }
    const marked = bl.includes("← YOUR CODE") || bl.includes("← culprit");
    if (marked) {
      markedFrameSeen = true;
    }
    const line = parseInt(fm[2], 10);
    if (line <= 0) {
      continue; // no source position — nothing to navigate to
    }
    const frame: StFrame = { file: fm[1], line, text: bl.trim() };
    frames.push(frame);
    if (!culprit && marked) {
      culprit = frame;
    }
  }
  // Fall back to the first frame ONLY when the block marked none. When a frame WAS marked
  // but had no usable position, jumping to some other frame is worse than not jumping: for
  // a wrapped exception that other frame is the `wrapped by:` line, in a different class.
  if (!culprit && !markedFrameSeen && frames.length > 0) {
    culprit = frames[0];
  }

  return {
    id,
    timestamp,
    headline,
    culprit,
    frames: framesWithoutDuplicateCulprit(culprit, frames),
    block: block.join("\n"),
  };
}

function stripCr(s: string): string {
  return s.endsWith("\r") ? s.slice(0, -1) : s;
}
