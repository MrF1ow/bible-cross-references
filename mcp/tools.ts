import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getBookGenre } from '../src/core/bible/genres.ts';
import type { VerseIndex } from '../src/core/bible/verse-ref.ts';
import { CANONICAL_VERSIFICATION } from '../src/core/bible/versification.ts';
import { TRANSLATION_IDS } from '../src/core/datasets/ids.ts';
import type {
  CrossReferenceIndex,
  CrossReferenceLink,
} from '../src/cross-references/cross-reference-index.ts';
import { getCrossReferenceSourceManifest } from '../src/cross-references/registry.ts';
import { DEFAULT_TRANSLATION_ID, TRANSLATION_MANIFESTS } from '../src/translations/registry.ts';
import type { Translation } from '../src/translations/translation.ts';
import { getWordSourceManifest } from '../src/words/registry.ts';
import type { BibleData, OriginalWords } from './bible-data.ts';
import { resolvePassage, verseRangeLabel, verseRangeOsis } from './references.ts';

/** The app's own default: links with at least 4 votes, the best supported 44% of them. */
export const DEFAULT_MIN_VOTES = 4;
/** A chapter is at most 176 verses (Psalm 119); anything longer is cut, and says so. */
export const MAX_PASSAGE_VERSES = 200;
/** Verses of a linked passage quoted in full; a longer target is cut short with an ellipsis. */
export const MAX_QUOTED_VERSES = 3;
/** Verses whose original words one call lists. */
export const MAX_WORD_VERSES = 10;

const VERSIFICATION = CANONICAL_VERSIFICATION;

const referenceInput = z
  .string()
  .min(1)
  .describe(
    'A verse ("John 3:16"), verse range ("Rom 8:28-30"), chapter ("Psalm 23"), chapter range ' +
      '("Gen 1-2") or OSIS ID ("Isa.53.5"). Book names may be abbreviated, and may be in ' +
      'English, Portuguese, German, Italian, Spanish or Ukrainian.',
  );

const translationInput = z
  .enum(TRANSLATION_IDS)
  .default(DEFAULT_TRANSLATION_ID)
  .describe(
    'Which Bible text to quote: bsb (Berean Standard Bible, English, the default), kjv (King ' +
      'James Version), blivre (Portuguese), luther1912 (German), riveduta1927 (Italian), vbl ' +
      '(Spanish).',
  );

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function translationCredit(translation: Translation): string {
  return translation.manifest.attribution;
}

/** The text of a verse range, cut after a few verses so one long target cannot flood a reply. */
function quote(translation: Translation, start: VerseIndex, end: VerseIndex): string {
  const last = Math.min(end, start + MAX_QUOTED_VERSES - 1);
  const parts: string[] = [];
  for (let verse = start; verse <= last; verse += 1) {
    parts.push(translation.verseText(verse));
  }
  const text = parts.filter((part) => part !== '').join(' ');
  return last < end ? `${text} …` : text;
}

export type LinkDirection = 'outgoing' | 'incoming' | 'both';

interface FoundLink {
  readonly direction: 'outgoing' | 'incoming';
  readonly link: CrossReferenceLink;
  /** The end of the link outside the passage asked about (or inside it, for a link within). */
  readonly otherStart: VerseIndex;
  readonly otherEnd: VerseIndex;
  /** The verse of the passage the link leaves from or arrives at. */
  readonly via: VerseIndex;
}

/** Every link touching the passage in the requested directions, each once per direction. */
function collectLinks(
  data: CrossReferenceIndex,
  start: VerseIndex,
  end: VerseIndex,
  direction: LinkDirection,
): FoundLink[] {
  const found: FoundLink[] = [];
  const seenIncoming = new Set<number>();
  for (let verse = start; verse <= end; verse += 1) {
    if (direction !== 'incoming') {
      for (const link of data.outgoing(verse)) {
        found.push({
          direction: 'outgoing',
          link,
          otherStart: link.targetStart,
          otherEnd: link.targetEnd,
          via: verse,
        });
      }
    }
    if (direction !== 'outgoing') {
      // A link to a range is an incoming link of every verse in it; it is listed once.
      for (const link of data.incoming(verse)) {
        if (!seenIncoming.has(link.id)) {
          seenIncoming.add(link.id);
          found.push({
            direction: 'incoming',
            link,
            otherStart: link.from,
            otherEnd: link.from,
            via: verse,
          });
        }
      }
    }
  }
  return found;
}

/** How many items fall under each key, largest first, at most `top` keys. */
function countBy<T>(
  items: readonly T[],
  key: (item: T) => string,
  top = Infinity,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const name = key(item);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, top),
  );
}

/** Books listed in a cross-reference summary; the genres already account for every link. */
export const SUMMARY_BOOKS = 10;

/** `G26`, `g0026` and `G0026` all name the same word; the dataset writes four digits. */
export function normalizeStrongs(input: string): string {
  const match = /^\s*([GgHh])0*(\d{1,4})([A-Za-z]?)\s*$/.exec(input);
  if (!match) {
    return input.trim().toUpperCase();
  }
  const [, letter = '', digits = '', suffix = ''] = match;
  return `${letter.toUpperCase()}${digits.padStart(4, '0')}${suffix.toUpperCase()}`;
}

/** Word positions for a Strong's number: the exact entry, or every lettered variant of it. */
function findWords(words: OriginalWords, strongs: string): number[] {
  const wanted = normalizeStrongs(strongs);
  const found: number[] = [];
  words.columns.strongs.forEach((entry, index) => {
    if (
      entry === wanted ||
      (entry.startsWith(wanted) && /^[A-Z]$/.test(entry.slice(wanted.length)))
    ) {
      found.push(index);
    }
  });
  return found;
}

/** An MCP server exposing the explorer's datasets as read-only tools. */
export function createBibleServer(data: BibleData): McpServer {
  const server = new McpServer(
    { name: 'bible-cross-references', version: '0.1.0' },
    {
      instructions:
        'Bible study tools over the datasets of the Bible Cross-References explorer: six openly ' +
        'licensed translations, 344,799 cross-references from OpenBible.info (largely the ' +
        'Treasury of Scripture Knowledge, ranked by reader votes) and the Hebrew and Greek words ' +
        "of each verse from STEPBible. Verse numbering is the KJV's. Start with " +
        'get_cross_references to see what a passage connects to, get_passage to read text, and ' +
        'get_original_words / find_verses_by_word to follow a Hebrew or Greek word. Quote the ' +
        'attribution a result carries when you show its text or data to someone.',
    },
  );
  const readOnly = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    'get_passage',
    {
      title: 'Read a passage',
      description: 'Returns the text of a verse, verse range or chapter, one entry per verse.',
      inputSchema: { reference: referenceInput, translation: translationInput },
      annotations: readOnly,
    },
    async ({ reference, translation: translationId }) => {
      const passage = resolvePassage(reference);
      const translation = await data.translation(translationId);
      const last = Math.min(passage.end, passage.start + MAX_PASSAGE_VERSES - 1);
      const verses = [];
      for (let verse = passage.start; verse <= last; verse += 1) {
        const text = translation.verseText(verse);
        verses.push({
          reference: verseRangeLabel(verse),
          osis: verseRangeOsis(verse),
          text: text === '' ? null : text,
        });
      }
      return json({
        passage: passage.label,
        osis: passage.osis,
        translation: translation.manifest.abbreviation,
        verses,
        ...(last < passage.end
          ? { truncated: `Only the first ${String(MAX_PASSAGE_VERSES)} verses are shown.` }
          : {}),
        ...(verses.some((verse) => verse.text === null)
          ? { note: 'A null text is a verse this translation omits.' }
          : {}),
        attribution: translationCredit(translation),
      });
    },
  );

  server.registerTool(
    'get_cross_references',
    {
      title: 'Follow cross-references',
      description:
        'Lists the cross-references of a verse, range or chapter, most-voted first: the ' +
        'passages it points to (outgoing), the passages that point to it (incoming), or both. ' +
        'Also counts where all the matching links land, by genre and (top ten) by book.',
      inputSchema: {
        reference: referenceInput,
        direction: z
          .enum(['outgoing', 'incoming', 'both'])
          .default('both')
          .describe('outgoing: what the passage points to; incoming: what points to it.'),
        min_votes: z
          .number()
          .int()
          .default(DEFAULT_MIN_VOTES)
          .describe(
            "Leave out links with fewer reader votes than this. 4 is the explorer's default " +
              '(the best supported 44% of links); 0 keeps every link not voted down; -100 keeps ' +
              'every link.',
          ),
        limit: z.number().int().min(1).max(200).default(25).describe('Most links to return.'),
        include_text: z
          .boolean()
          .default(true)
          .describe('Quote the linked passages (at most three verses each).'),
        translation: translationInput,
      },
      annotations: readOnly,
    },
    async ({
      reference,
      direction,
      min_votes,
      limit,
      include_text,
      translation: translationId,
    }) => {
      const passage = resolvePassage(reference);
      const index = await data.crossReferences();
      const translation = include_text ? await data.translation(translationId) : undefined;
      const matching = collectLinks(index, passage.start, passage.end, direction)
        .filter((found) => found.link.votes >= min_votes)
        .sort((a, b) => b.link.votes - a.link.votes || a.otherStart - b.otherStart);
      const source = getCrossReferenceSourceManifest('openbible');
      return json({
        passage: passage.label,
        osis: passage.osis,
        direction,
        min_votes,
        total: matching.length,
        shown: Math.min(limit, matching.length),
        by_genre: countBy(
          matching,
          (found) => getBookGenre(VERSIFICATION.refAt(found.otherStart).book).name,
        ),
        top_books: countBy(
          matching,
          (found) => VERSIFICATION.bookAt(found.otherStart).name,
          SUMMARY_BOOKS,
        ),
        links: matching.slice(0, limit).map((found) => ({
          direction: found.direction,
          reference: verseRangeLabel(found.otherStart, found.otherEnd),
          osis: verseRangeOsis(found.otherStart, found.otherEnd),
          votes: found.link.votes,
          genre: getBookGenre(VERSIFICATION.refAt(found.otherStart).book).name,
          ...(passage.start === passage.end ? {} : { via: verseRangeLabel(found.via) }),
          ...(translation ? { text: quote(translation, found.otherStart, found.otherEnd) } : {}),
        })),
        attribution: [source.attribution, ...(translation ? [translationCredit(translation)] : [])],
      });
    },
  );

  server.registerTool(
    'get_original_words',
    {
      title: 'Hebrew and Greek words of a verse',
      description:
        'Lists the dictionary forms of the Hebrew or Greek words behind a verse (or up to ten ' +
        "verses), least common first, with transliteration, an English gloss, the Strong's " +
        'number and how many verses of the Bible use each word. Very common words are left out.',
      inputSchema: { reference: referenceInput },
      annotations: readOnly,
    },
    async ({ reference }) => {
      const passage = resolvePassage(reference);
      const words = await data.originalWords();
      const last = Math.min(passage.end, passage.start + MAX_WORD_VERSES - 1);
      const verses = [];
      for (let verse = passage.start; verse <= last; verse += 1) {
        verses.push({
          reference: verseRangeLabel(verse),
          words: words.index.wordsOf(verse).map((word) => ({
            strongs: word.strongs,
            lemma: word.lemma,
            transliteration: word.transliteration,
            gloss: word.gloss,
            verse_count: word.verseCount,
          })),
        });
      }
      return json({
        passage: passage.label,
        verses,
        ...(last < passage.end
          ? { truncated: `Only the first ${String(MAX_WORD_VERSES)} verses are shown.` }
          : {}),
        note:
          `Words used in more than ${String(words.maxVerses)} verses are left out. ` +
          "Use find_verses_by_word with a Strong's number to see every verse that uses a word.",
        attribution: getWordSourceManifest('stepbible').attribution,
      });
    },
  );

  server.registerTool(
    'find_verses_by_word',
    {
      title: 'Verses that share a Hebrew or Greek word',
      description:
        "Lists every verse that uses a word of the original languages, by its Strong's number " +
        '(e.g. G4128 for πλῆθος, H7225 for רֵאשִׁית). Unlike a cross-reference, this is the ' +
        "plain fact that two verses share a word, not anyone's judgement that they belong " +
        'together.',
      inputSchema: {
        strongs: z.string().min(2).describe('Strong\'s number, e.g. "G4128", "g26" or "H7225".'),
        limit: z.number().int().min(1).max(500).default(50).describe('Most verses to return.'),
        include_text: z.boolean().default(false).describe('Quote each verse.'),
        translation: translationInput,
      },
      annotations: readOnly,
    },
    async ({ strongs, limit, include_text, translation: translationId }) => {
      const words = await data.originalWords();
      const found = findWords(words, strongs);
      if (found.length === 0) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                `No word ${normalizeStrongs(strongs)} in the dataset. Either the number does ` +
                `not exist or the word is used in more than ${String(words.maxVerses)} verses, ` +
                'which are left out.',
            },
          ],
        };
      }
      const translation = include_text ? await data.translation(translationId) : undefined;
      const verses = [...new Set(found.flatMap((word) => words.index.versesOf(word)))].sort(
        (a, b) => a - b,
      );
      const { strongs: numbers, lemma, transliteration, gloss } = words.columns;
      return json({
        words: found.map((word) => ({
          strongs: numbers[word],
          lemma: lemma[word],
          transliteration: transliteration[word],
          gloss: gloss[word],
        })),
        total: verses.length,
        verses: verses.slice(0, limit).map((verse) => ({
          reference: verseRangeLabel(verse),
          osis: verseRangeOsis(verse),
          ...(translation ? { text: translation.verseText(verse) } : {}),
        })),
        attribution: [
          getWordSourceManifest('stepbible').attribution,
          ...(translation ? [translationCredit(translation)] : []),
        ],
      });
    },
  );

  server.registerTool(
    'search_text',
    {
      title: 'Search the text',
      description:
        'Finds verses containing a word or phrase in one translation (case-insensitive, ' +
        'ignoring quote styles), in canonical order.',
      inputSchema: {
        query: z.string().min(1).describe('A word or exact phrase, e.g. "living water".'),
        translation: translationInput,
        limit: z.number().int().min(1).max(200).default(20).describe('Most verses to return.'),
      },
      annotations: readOnly,
    },
    async ({ query, translation: translationId, limit }) => {
      const translation = await data.translation(translationId);
      const result = translation.search(query, limit);
      return json({
        query,
        translation: translation.manifest.abbreviation,
        total: result.totalCount,
        verses: result.verses.map((verse) => ({
          reference: verseRangeLabel(verse),
          osis: verseRangeOsis(verse),
          text: translation.verseText(verse),
        })),
        attribution: translationCredit(translation),
      });
    },
  );

  server.registerTool(
    'list_sources',
    {
      title: 'Translations and data sources',
      description:
        'Lists the translations get_passage can quote and the datasets behind the other tools, ' +
        'with their licences and the credit each one asks for.',
      annotations: readOnly,
    },
    () => {
      const cross = getCrossReferenceSourceManifest('openbible');
      const words = getWordSourceManifest('stepbible');
      return json({
        translations: TRANSLATION_MANIFESTS.map((manifest) => ({
          id: manifest.id,
          name: manifest.name,
          abbreviation: manifest.abbreviation,
          language: manifest.language,
          license: manifest.license.name,
          attribution: manifest.attribution,
        })),
        cross_references: {
          name: cross.name,
          description: cross.description,
          license: cross.license.name,
          attribution: cross.attribution,
        },
        original_words: {
          name: words.name,
          description: words.description,
          license: words.license.name,
          attribution: words.attribution,
        },
      });
    },
  );

  return server;
}
