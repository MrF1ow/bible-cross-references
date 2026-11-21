import { getBook } from '../src/core/bible/books.ts';
import { parsePassageOsisId, passageRange } from '../src/core/bible/passage.ts';
import { formatVerseIndexRange } from '../src/core/bible/reference-format.ts';
import {
  parseReference,
  type ParsedReference,
  type ReferenceParseError,
  type ReferenceParseResult,
} from '../src/core/bible/reference-parse.ts';
import { toOsisId, type VerseIndex } from '../src/core/bible/verse-ref.ts';
import { CANONICAL_VERSIFICATION } from '../src/core/bible/versification.ts';
import { deBooks } from '../src/i18n/books/de.ts';
import { enBooks } from '../src/i18n/books/en.ts';
import { esBooks } from '../src/i18n/books/es.ts';
import { itBooks } from '../src/i18n/books/it.ts';
import { ptBooks } from '../src/i18n/books/pt.ts';
import type { BookNames } from '../src/i18n/books/types.ts';
import { ukBooks } from '../src/i18n/books/uk.ts';

const VERSIFICATION = CANONICAL_VERSIFICATION;

/**
 * Book names an agent may use, English first. The app reads a reference in the reader's own
 * language; an agent has no such setting, so every language the interface speaks is tried.
 */
const BOOK_NAME_SETS: readonly BookNames[] = [enBooks, ptBooks, deBooks, itBooks, esBooks, ukBooks];

/** An inclusive run of verses an agent asked about: one verse, a range or a whole chapter. */
export interface ResolvedPassage {
  /** How the passage is written in English, e.g. `John 3:16–18`. */
  readonly label: string;
  /** OSIS ID, e.g. `John.3.16` or `John.3.16-John.3.18`. */
  readonly osis: string;
  readonly start: VerseIndex;
  readonly end: VerseIndex;
}

/** A reference that names no passage. The message is written for the agent to act on. */
export class PassageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassageNotFoundError';
  }
}

/** A verse or an inclusive verse range, written in English, e.g. `Romans 1:19–20`. */
export function verseRangeLabel(start: VerseIndex, end: VerseIndex = start): string {
  return formatVerseIndexRange(VERSIFICATION, enBooks, start, end);
}

/** A verse or an inclusive verse range as OSIS, e.g. `Rom.1.19-Rom.1.20`. */
export function verseRangeOsis(start: VerseIndex, end: VerseIndex = start): string {
  const first = toOsisId(VERSIFICATION.refAt(start));
  return start === end ? first : `${first}-${toOsisId(VERSIFICATION.refAt(end))}`;
}

function passage(start: VerseIndex, end: VerseIndex): ResolvedPassage {
  return { label: verseRangeLabel(start, end), osis: verseRangeOsis(start, end), start, end };
}

function isInformative(error: ReferenceParseError): boolean {
  return error.kind !== 'unreadable' && error.kind !== 'unknown-book';
}

/**
 * Reads a reference against every language's book names. The first language that knows the book
 * wins; if none does, the most useful error is kept, so `Joh 3:99` reports a missing verse (it is
 * German for John) rather than an unknown book (which it is in English).
 */
function parseInAnyLanguage(input: string): ReferenceParseResult {
  let best: ReferenceParseResult | undefined;
  for (const names of BOOK_NAME_SETS) {
    const result = parseReference(input, VERSIFICATION, names);
    if (result.ok) {
      return result;
    }
    if (best === undefined || (!isInformative(errorOf(best)) && isInformative(result.error))) {
      best = result;
    }
  }
  return best ?? { ok: false, error: { kind: 'unreadable' } };
}

function errorOf(result: ReferenceParseResult): ReferenceParseError {
  return result.ok ? { kind: 'unreadable' } : result.error;
}

function describeError(input: string, error: ReferenceParseError): string {
  switch (error.kind) {
    case 'unreadable':
      return (
        `Could not read "${input}" as a Bible reference. Write it like "John 3:16", ` +
        `"Ps 23", "Rom 8:28-30", "Gen 1-2" or "Gen.1.1".`
      );
    case 'unknown-book':
      return `No book of the Bible is called "${error.query}".`;
    case 'ambiguous-book':
      return (
        `"${error.query}" could be ${error.candidates.map((id) => getBook(id).name).join(', ')}. ` +
        'Use more of the name.'
      );
    case 'no-such-chapter':
      return `${getBook(error.book).name} has ${String(error.chapters)} chapters.`;
    case 'no-such-verse':
      return (
        `${getBook(error.book).name} ${String(error.chapter)} has ` +
        `${String(error.verses)} verses.`
      );
  }
}

function startOf(reference: ParsedReference): VerseIndex {
  const { book, chapter, verse } = reference;
  const range = VERSIFICATION.chapterRange(book, chapter);
  const index =
    verse === undefined ? range?.start : VERSIFICATION.indexOf({ book, chapter, verse });
  if (index === undefined) {
    throw new PassageNotFoundError(`No such passage: ${book} ${String(chapter)}.`);
  }
  return index;
}

/** `John 3:16-18` (verses) or `Gen 1-3` (chapters): a reference, a dash and a closing number. */
const RANGE_PATTERN = /^(?<head>.*\d)\s*[-–—]\s*(?<end>\d+)$/u;

function resolveRange(input: string, head: string, endText: string): ResolvedPassage {
  const first = parseInAnyLanguage(head);
  if (!first.ok) {
    throw new PassageNotFoundError(describeError(input, first.error));
  }
  const { book, chapter, verse } = first.reference;
  const endNumber = Number(endText);
  const start = startOf(first.reference);
  const end =
    verse === undefined
      ? VERSIFICATION.chapterRange(book, endNumber)?.end
      : VERSIFICATION.indexOf({ book, chapter, verse: endNumber });
  if (end === undefined || end < start) {
    const what = verse === undefined ? 'chapter' : 'verse';
    throw new PassageNotFoundError(
      `"${input}" ends at ${what} ${endText}, which does not exist after where it starts.`,
    );
  }
  return passage(start, end);
}

/**
 * Turns what an agent wrote into a passage. Accepts a verse (`John 3:16`), a verse range
 * (`John 3:16-18`), a chapter (`Psalm 23`), a chapter range (`Gen 1-2`), OSIS IDs (`Gen.1.1`,
 * `Isa.53`) and book names in any language the app speaks (`João 3:16`, `Joh 3,16`).
 */
export function resolvePassage(input: string): ResolvedPassage {
  const trimmed = input.trim();
  const osis = parsePassageOsisId(trimmed, VERSIFICATION);
  if (osis) {
    const range = passageRange(osis, VERSIFICATION);
    return passage(range.start, range.end);
  }
  const range = RANGE_PATTERN.exec(trimmed)?.groups;
  if (range?.['head'] !== undefined && range['end'] !== undefined) {
    return resolveRange(trimmed, range['head'], range['end']);
  }
  const parsed = parseInAnyLanguage(trimmed);
  if (!parsed.ok) {
    throw new PassageNotFoundError(describeError(trimmed, parsed.error));
  }
  const start = startOf(parsed.reference);
  const { book, chapter, verse } = parsed.reference;
  const end =
    verse === undefined ? (VERSIFICATION.chapterRange(book, chapter)?.end ?? start) : start;
  return passage(start, end);
}
