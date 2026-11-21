import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CANONICAL_VERSIFICATION } from '../src/core/bible/versification.ts';
import {
  parseCrossReferencesFile,
  parseOriginalWordsFile,
  parseTranslationTextFile,
  type OriginalWordColumns,
} from '../src/core/datasets/formats.ts';
import type { TranslationId } from '../src/core/datasets/ids.ts';
import {
  crossReferencesDatasetPath,
  originalWordsDatasetPath,
  translationDatasetPath,
} from '../src/core/datasets/paths.ts';
import { CrossReferenceIndex } from '../src/cross-references/cross-reference-index.ts';
import { getCrossReferenceSourceManifest } from '../src/cross-references/registry.ts';
import { getTranslationManifest } from '../src/translations/registry.ts';
import { Translation } from '../src/translations/translation.ts';
import { OriginalWordIndex } from '../src/words/original-words.ts';
import { getWordSourceManifest } from '../src/words/registry.ts';

/** Reads a generated dataset, by its path relative to the site root (e.g. `data/…/bsb.json`). */
export type DatasetReader = (path: string) => Promise<unknown>;

/** Where `bun run data:build` writes the datasets: the site root the app serves them from. */
export const DEFAULT_SITE_ROOT = resolve(import.meta.dirname, '../public');

/** Reads datasets from disk, saying how to make them when they are not there. */
export function fileDatasetReader(siteRoot: string = DEFAULT_SITE_ROOT): DatasetReader {
  return async (path) => {
    const file = join(siteRoot, path);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(
          `The dataset ${path} has not been built (looked in ${siteRoot}). ` +
            'Run `bun run data:build` in the repository, or set BIBLE_SITE_ROOT.',
          { cause: error },
        );
      }
      throw error;
    }
    return JSON.parse(text) as unknown;
  };
}

/** The original-language words, with the columns kept for looking a word up by number. */
export interface OriginalWords {
  readonly index: OriginalWordIndex;
  readonly columns: OriginalWordColumns;
  /** Words used in more verses than this are not in the dataset at all. */
  readonly maxVerses: number;
}

/**
 * The app's datasets, loaded once each and only when first asked for: a translation is ~4 MB
 * of JSON, and an agent that only follows cross-references never needs five of the six.
 *
 * A load that fails is forgotten rather than cached, so building the datasets while the server
 * runs is enough to fix it.
 */
export class BibleData {
  readonly #read: DatasetReader;
  readonly #loads = new Map<string, Promise<unknown>>();

  constructor(read: DatasetReader) {
    this.#read = read;
  }

  #once<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#loads.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const loading = load().catch((error: unknown) => {
      this.#loads.delete(key);
      throw error;
    });
    this.#loads.set(key, loading);
    return loading;
  }

  crossReferences(): Promise<CrossReferenceIndex> {
    const manifest = getCrossReferenceSourceManifest('openbible');
    return this.#once('cross-references', async () => {
      const file = parseCrossReferencesFile(
        await this.#read(crossReferencesDatasetPath(manifest.id)),
        { id: manifest.id, versification: CANONICAL_VERSIFICATION.id },
      );
      return new CrossReferenceIndex(file.links, CANONICAL_VERSIFICATION.verseCount);
    });
  }

  translation(id: TranslationId): Promise<Translation> {
    const manifest = getTranslationManifest(id);
    return this.#once(`translation:${id}`, async () => {
      const file = parseTranslationTextFile(await this.#read(translationDatasetPath(id)), {
        id,
        versification: CANONICAL_VERSIFICATION.id,
      });
      return new Translation(manifest, CANONICAL_VERSIFICATION, file);
    });
  }

  originalWords(): Promise<OriginalWords> {
    const manifest = getWordSourceManifest('stepbible');
    return this.#once('original-words', async () => {
      const file = parseOriginalWordsFile(await this.#read(originalWordsDatasetPath(manifest.id)), {
        id: manifest.id,
        versification: CANONICAL_VERSIFICATION.id,
      });
      return {
        index: new OriginalWordIndex(file.words, CANONICAL_VERSIFICATION.verseCount),
        columns: file.words,
        maxVerses: file.maxVerses,
      };
    });
  }
}
