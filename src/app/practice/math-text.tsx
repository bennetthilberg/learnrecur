"use client";

import katex from "katex";
import { Fragment, type ReactNode } from "react";

const KATEX_OPTIONS = {
  output: "htmlAndMathml",
  strict: "warn",
  throwOnError: false,
  trust: false,
} as const;

type MathTextProps = {
  text: string;
  className?: string;
};

type MathTextSegment =
  | {
      kind: "text";
      value: string;
    }
  | {
      kind: "math";
      value: string;
      displayMode: boolean;
      original: string;
    };

export function MathText({ text, className }: MathTextProps) {
  const segments = splitMathText(text);

  return (
    <span className={className}>
      {segments.map((segment, index) => (
        <Fragment key={`${segment.kind}-${index}-${segment.value.slice(0, 8)}`}>
          {renderSegment(segment)}
        </Fragment>
      ))}
    </span>
  );
}

function renderSegment(segment: MathTextSegment): ReactNode {
  if (segment.kind === "text") {
    return segment.value;
  }

  const html = renderKatex(segment.value, segment.displayMode);

  if (!html) {
    return segment.original;
  }

  return (
    <span
      className={segment.displayMode ? "mathTextDisplay" : "mathTextInline"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderKatex(value: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(value, {
      ...KATEX_OPTIONS,
      displayMode,
    });
  } catch {
    return null;
  }
}

function splitMathText(text: string): MathTextSegment[] {
  const segments: MathTextSegment[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const opening = findNextOpeningDelimiter(text, cursor);

    if (!opening) {
      segments.push({ kind: "text", value: text.slice(cursor) });
      break;
    }

    if (opening.index > cursor) {
      segments.push({ kind: "text", value: text.slice(cursor, opening.index) });
    }

    const contentStart = opening.index + opening.open.length;
    const closingIndex = text.indexOf(opening.close, contentStart);

    if (closingIndex === -1) {
      segments.push({ kind: "text", value: text.slice(opening.index) });
      break;
    }

    const original = text.slice(opening.index, closingIndex + opening.close.length);
    const value = text.slice(contentStart, closingIndex).trim();

    if (value.length === 0) {
      segments.push({ kind: "text", value: original });
    } else {
      segments.push({
        kind: "math",
        value,
        displayMode: opening.displayMode,
        original,
      });
    }

    cursor = closingIndex + opening.close.length;
  }

  return segments.length > 0 ? segments : [{ kind: "text", value: text }];
}

function findNextOpeningDelimiter(
  text: string,
  start: number,
): { index: number; open: string; close: string; displayMode: boolean } | null {
  const delimiters = [
    { open: "\\[", close: "\\]", displayMode: true },
    { open: "$$", close: "$$", displayMode: true },
    { open: "\\(", close: "\\)", displayMode: false },
    { open: "$", close: "$", displayMode: false },
  ];

  return delimiters
    .map((delimiter) => ({
      ...delimiter,
      index: text.indexOf(delimiter.open, start),
    }))
    .filter((candidate) => candidate.index !== -1)
    .toSorted((left, right) => left.index - right.index || right.open.length - left.open.length)[0] ?? null;
}
