// @vitest-environment node
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OriginalWordsFile, CrossReferencesFile } from '../src/core/datasets/formats.ts';
import {
  createCrossReferenceColumns,
  createTranslationFile,
  PROVENANCE,
  verseIndex,
} from '../src/test-utils/fixtures.ts';
import {
  BibleData,
  DEFAULT_SITE_ROOT,
  fileDatasetReader,
  type DatasetReader,
} from './bible-data.ts';
import { handleHttpRequest } from './http.ts';
import { PassageNotFoundError, resolvePassage } from './references.ts';
import { createBibleServer, normalizeStrongs } from './tools.ts';

const JOHN_3_16 = verseIndex('John', 3, 16);
const ROM_5_8 = verseIndex('Rom', 5, 8);
const GEN_1_1 = verseIndex('Gen', 1, 1);
const GEN_1_27 = verseIndex('Gen', 1, 27);
const ACTS_5_14 = verseIndex('Acts', 5, 14);
const LUKE_5_6 = verseIndex('Luke', 5, 6);

function crossReferencesFile(): CrossReferencesFile {
  return {
    format: 'cross-references',
    schemaVersion: 1,
    versification: 'kjv',
    provenance: PROVENANCE,
    notices: [],
    sourceId: 'openbible',
    sourceRowCount: 5,
    links: createCrossReferenceColumns([
      { from: JOHN_3_16, to: ROM_5_8, votes: 983 },
      // A five-verse target, quoted only in part.
      { from: JOHN_3_16, to: verseIndex('Rom', 1, 1), toEnd: verseIndex('Rom', 1, 5), votes: 50 },
      { from: GEN_1_1, to: JOHN_3_16, votes: 10 },
      // A range that includes John 3:16 twice over when asking about John 3:16–17.
      { from: GEN_1_27, to: JOHN_3_16, toEnd: verseIndex('John', 3, 17), votes: 7 },
      // Below the default threshold of 4 votes.
      { from: JOHN_3_16, to: LUKE_5_6, votes: 2 },
    ]),
  };
}

function originalWordsFile(): OriginalWordsFile {
  return {
    format: 'original-words',
    schemaVersion: 1,
    versification: 'kjv',
    provenance: PROVENANCE,
    notices: [],
    sourceId: 'stepbible',
    license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    attribution: 'Original-language words: STEP Bible (CC BY 4.0).',
    maxVerses: 100,
    words: {
      strongs: ['G4128', 'H1254A', 'H1254B'],
      lemma: ['πλῆθος', 'בָּרָא', 'בָּרָא'],
      transliteration: ['plēthos', 'bara', 'bara'],
      gloss: ['multitude', 'to create', 'to fatten'],
      offsets: [0, 2, 3, 4],
      verses: [LUKE_5_6, ACTS_5_14, GEN_1_1, GEN_1_27],
    },
  };
}

const DATASETS: Readonly<Record<string, unknown>> = {
  'data/cross-references/openbible.json': crossReferencesFile(),
  'data/words/stepbible.json': originalWordsFile(),
  'data/translations/bsb.json': createTranslationFile(
    new Map([
      [JOHN_3_16, 'For God so loved the world.'],
      [ROM_5_8, 'But God proves His love for us.'],
      [verseIndex('Matt', 17, 21), ''],
    ]),
  ),
  'data/translations/kjv.json': {
    ...createTranslationFile(new Map([[JOHN_3_16, 'For God so loved the world, KJV.']])),
    translationId: 'kjv',
  },
};

function fixtureReader(): DatasetReader & { reads: string[] } {
  const reads: string[] = [];
  const read = (path: string): Promise<unknown> => {
    reads.push(path);
    const dataset = DATASETS[path];
    return dataset === undefined
      ? Promise.reject(new Error(`No fixture for ${path}`))
      : Promise.resolve(dataset);
  };
  return Object.assign(read, { reads });
}

describe('resolvePassage', () => {
  it.each([
    ['John 3:16', 'John 3:16', 'John.3.16'],
    ['jn 3 16', 'John 3:16', 'John.3.16'],
    ['John 3:16-18', 'John 3:16–18', 'John.3.16-John.3.18'],
    ['Psalm 23', 'Psalm 23:1–6', 'Ps.23.1-Ps.23.6'],
    ['Gen 1-2', 'Genesis 1:1–2:25', 'Gen.1.1-Gen.2.25'],
    ['Isa.53', 'Isaiah 53:1–12', 'Isa.53.1-Isa.53.12'],
    ['Gen.1.1', 'Genesis 1:1', 'Gen.1.1'],
    ['João 3:16', 'John 3:16', 'John.3.16'],
    ['Joh 3,16', 'John 3:16', 'John.3.16'],
  ])('reads %s', (input, label, osis) => {
    const passage = resolvePassage(input);
    expect(passage.label).toBe(label);
    expect(passage.osis).toBe(osis);
  });

  it.each([
    ['', /Could not read/],
    ['Hezekiah 3:1', /No book of the Bible is called "Hezekiah"/],
    ['Ph 1:1', /"Ph" could be Philippians, Philemon/],
    ['John 30', /John has 21 chapters/],
    ['John 3:99', /John 3 has 36 verses/],
    ['Joh 3:99', /John 3 has 36 verses/],
    ['John 3:16-99', /ends at verse 99/],
    ['John 3:16-2', /ends at verse 2/],
    ['Gen 2-1', /ends at chapter 1/],
    ['Hezekiah 3:1-2', /No book of the Bible is called "Hezekiah"/],
  ])('explains why %j names no passage', (input, message) => {
    expect(() => resolvePassage(input)).toThrow(PassageNotFoundError);
    expect(() => resolvePassage(input)).toThrow(message);
  });
});

describe('normalizeStrongs', () => {
  it.each([
    ['g26', 'G0026'],
    ['G0026', 'G0026'],
    [' h1254a ', 'H1254A'],
    ['G3123G', 'G3123G'],
    ['strong', 'STRONG'],
  ])('writes %j as %j', (input, expected) => {
    expect(normalizeStrongs(input)).toBe(expected);
  });
});

describe('BibleData', () => {
  it('loads each dataset once, however often it is asked for', async () => {
    const read = fixtureReader();
    const data = new BibleData(read);
    const [first, second] = await Promise.all([data.crossReferences(), data.crossReferences()]);
    expect(first).toBe(second);
    await data.translation('bsb');
    await data.translation('bsb');
    await data.originalWords();
    expect(read.reads).toEqual([
      'data/cross-references/openbible.json',
      'data/translations/bsb.json',
      'data/words/stepbible.json',
    ]);
  });

  it('forgets a failed load, so building the datasets afterwards is enough', async () => {
    let built = false;
    const data = new BibleData((path) =>
      built ? fixtureReader()(path) : Promise.reject(new Error('not built')),
    );
    await expect(data.translation('kjv')).rejects.toThrow('not built');
    built = true;
    await expect(data.translation('kjv')).resolves.toMatchObject({ verseCount: 31102 });
  });
});

describe('fileDatasetReader', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'bible-mcp-'));
  });

  it('reads a dataset under the site root', async () => {
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data/x.json'), '{"a":1}');
    await expect(fileDatasetReader(root)('data/x.json')).resolves.toEqual({ a: 1 });
  });

  it('says how to build a dataset that is missing', async () => {
    await expect(fileDatasetReader(root)('data/missing.json')).rejects.toThrow(
      /has not been built.*bun run data:build/,
    );
  });

  it('passes on any other failure', async () => {
    await mkdir(join(root, 'data/dir.json'), { recursive: true });
    await expect(fileDatasetReader(root)('data/dir.json')).rejects.toThrow(/EISDIR/);
  });

  it('defaults to public/, where the build writes', () => {
    expect(DEFAULT_SITE_ROOT.endsWith('public')).toBe(true);
    expect(typeof fileDatasetReader()).toBe('function');
  });
});

describe('MCP tools', () => {
  let client: Client;

  beforeEach(async () => {
    const server = createBibleServer(new BibleData(fixtureReader()));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  async function call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ isError: boolean; text: string; json: () => Record<string, unknown> }> {
    const result = await client.callTool({ name, arguments: args });
    const [first] = result.content as { type: string; text: string }[];
    const text = first?.text ?? '';
    return {
      isError: result.isError === true,
      text,
      json: () => JSON.parse(text) as Record<string, unknown>,
    };
  }

  it('lists every tool as read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'get_passage',
      'get_cross_references',
      'get_original_words',
      'find_verses_by_word',
      'search_text',
      'list_sources',
    ]);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  describe('get_passage', () => {
    it('quotes a verse in the default translation, with its credit', async () => {
      const result = (await call('get_passage', { reference: 'John 3:16' })).json();
      expect(result).toMatchObject({
        passage: 'John 3:16',
        translation: 'BSB',
        verses: [
          { reference: 'John 3:16', osis: 'John.3.16', text: 'For God so loved the world.' },
        ],
        attribution: expect.stringContaining('Berean Standard Bible') as unknown,
      });
      expect(result).not.toHaveProperty('truncated');
      expect(result).not.toHaveProperty('note');
    });

    it('quotes another translation when asked', async () => {
      const result = (
        await call('get_passage', { reference: 'John 3:16', translation: 'kjv' })
      ).json();
      expect(result['verses']).toEqual([
        { reference: 'John 3:16', osis: 'John.3.16', text: 'For God so loved the world, KJV.' },
      ]);
    });

    it('marks a verse the translation omits', async () => {
      const result = (await call('get_passage', { reference: 'Matt 17:21' })).json();
      expect(result['verses']).toEqual([
        { reference: 'Matthew 17:21', osis: 'Matt.17.21', text: null },
      ]);
      expect(result['note']).toMatch(/omits/);
    });

    it('cuts a passage longer than any chapter', async () => {
      const result = (await call('get_passage', { reference: 'Ps 118-119' })).json();
      expect(result['verses']).toHaveLength(200);
      expect(result['truncated']).toMatch(/first 200 verses/);
    });

    it('reports a reference that names no passage as an error', async () => {
      const result = await call('get_passage', { reference: 'John 3:99' });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/John 3 has 36 verses/);
    });
  });

  describe('get_cross_references', () => {
    it('lists the best-supported links of a verse first, with where they land', async () => {
      const result = (await call('get_cross_references', { reference: 'John 3:16' })).json();
      expect(result).toMatchObject({
        passage: 'John 3:16',
        direction: 'both',
        min_votes: 4,
        total: 4,
        shown: 4,
        by_genre: { 'Pauline Epistles': 2, Law: 2 },
        top_books: { Romans: 2, Genesis: 2 },
      });
      expect(result['links']).toEqual([
        {
          direction: 'outgoing',
          reference: 'Romans 5:8',
          osis: 'Rom.5.8',
          votes: 983,
          genre: 'Pauline Epistles',
          text: 'But God proves His love for us.',
        },
        {
          direction: 'outgoing',
          reference: 'Romans 1:1–5',
          osis: 'Rom.1.1-Rom.1.5',
          votes: 50,
          genre: 'Pauline Epistles',
          text: expect.stringMatching(/ …$/) as unknown,
        },
        {
          direction: 'incoming',
          reference: 'Genesis 1:1',
          osis: 'Gen.1.1',
          votes: 10,
          genre: 'Law',
          text: expect.any(String) as unknown,
        },
        {
          direction: 'incoming',
          reference: 'Genesis 1:27',
          osis: 'Gen.1.27',
          votes: 7,
          genre: 'Law',
          text: expect.any(String) as unknown,
        },
      ]);
      expect(result['attribution']).toEqual([
        expect.stringContaining('OpenBible.info'),
        expect.stringContaining('Berean Standard Bible'),
      ]);
    });

    it('follows one direction, keeps low-voted links and leaves the text out when asked', async () => {
      const result = (
        await call('get_cross_references', {
          reference: 'John 3:16-17',
          direction: 'incoming',
          min_votes: -100,
          include_text: false,
          limit: 1,
        })
      ).json();
      // Genesis 1:27 points at John 3:16–17: one link, though it lands on both verses.
      expect(result).toMatchObject({ total: 2, shown: 1 });
      expect(result['links']).toEqual([
        {
          direction: 'incoming',
          reference: 'Genesis 1:1',
          osis: 'Gen.1.1',
          votes: 10,
          genre: 'Law',
          via: 'John 3:16',
        },
      ]);
      expect(result['attribution']).toEqual([expect.stringContaining('OpenBible.info')]);
    });

    it('counts outgoing links only, including the ones below the default threshold', async () => {
      const result = (
        await call('get_cross_references', {
          reference: 'John 3:16',
          direction: 'outgoing',
          min_votes: 0,
          include_text: false,
        })
      ).json();
      expect(result).toMatchObject({ total: 3, top_books: { Romans: 2, Luke: 1 } });
    });
  });

  describe('get_original_words', () => {
    it('lists the words of a verse with how often each is used', async () => {
      const result = (await call('get_original_words', { reference: 'Acts 5:14' })).json();
      expect(result['verses']).toEqual([
        {
          reference: 'Acts 5:14',
          words: [
            {
              strongs: 'G4128',
              lemma: 'πλῆθος',
              transliteration: 'plēthos',
              gloss: 'multitude',
              verse_count: 2,
            },
          ],
        },
      ]);
      expect(result['note']).toMatch(/more than 100 verses/);
      expect(result).not.toHaveProperty('truncated');
    });

    it('stops after ten verses', async () => {
      const result = (await call('get_original_words', { reference: 'Gen 1:1-12' })).json();
      expect(result['verses']).toHaveLength(10);
      expect(result['truncated']).toMatch(/first 10 verses/);
    });
  });

  describe('find_verses_by_word', () => {
    it('lists the verses that share a word', async () => {
      const result = (await call('find_verses_by_word', { strongs: 'g4128' })).json();
      expect(result).toMatchObject({
        words: [
          { strongs: 'G4128', lemma: 'πλῆθος', transliteration: 'plēthos', gloss: 'multitude' },
        ],
        total: 2,
        verses: [
          { reference: 'Luke 5:6', osis: 'Luke.5.6' },
          { reference: 'Acts 5:14', osis: 'Acts.5.14' },
        ],
        attribution: [expect.stringContaining('STEP Bible')],
      });
    });

    it('gathers every lettered variant of a number, and quotes when asked', async () => {
      const result = (
        await call('find_verses_by_word', { strongs: 'H1254', include_text: true, limit: 1 })
      ).json();
      expect(result['words']).toHaveLength(2);
      expect(result['total']).toBe(2);
      expect(result['verses']).toEqual([
        { reference: 'Genesis 1:1', osis: 'Gen.1.1', text: expect.any(String) as unknown },
      ]);
      expect(result['attribution']).toHaveLength(2);
    });

    it('explains a number it does not have', async () => {
      const result = await call('find_verses_by_word', { strongs: 'G9999' });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/No word G9999.*more than 100 verses/);
    });
  });

  it('search_text finds a phrase and counts every match', async () => {
    const result = (await call('search_text', { query: 'so loved', limit: 5 })).json();
    expect(result).toMatchObject({
      query: 'so loved',
      translation: 'BSB',
      total: 1,
      verses: [{ reference: 'John 3:16', text: 'For God so loved the world.' }],
    });
  });

  it('list_sources names every translation and dataset with its licence', async () => {
    const result = (await call('list_sources')).json();
    expect(result['translations']).toHaveLength(6);
    expect(result).toMatchObject({
      cross_references: { license: 'CC BY 4.0' },
      original_words: { license: 'CC BY 4.0' },
    });
  });
});

describe('handleHttpRequest', () => {
  const transport = { handleRequest: vi.fn(() => Promise.resolve(new Response('mcp'))) };
  const connect = vi.fn(() => Promise.resolve(transport));

  function request(path: string, headers: Record<string, string> = {}): Request {
    return new Request(`http://localhost${path}`, { method: 'POST', headers });
  }

  it('answers a health check without touching MCP', async () => {
    const response = await handleHttpRequest(request('/health'), { token: 'secret', connect });
    expect(await response.json()).toEqual({ ok: true });
    expect(connect).not.toHaveBeenCalled();
  });

  it('turns away any other path', async () => {
    const response = await handleHttpRequest(request('/'), { token: undefined, connect });
    expect(response.status).toBe(404);
  });

  it('asks for the token when one is set', async () => {
    for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
      const response = await handleHttpRequest(request('/mcp', headers), {
        token: 'secret',
        connect,
      });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
    }
    expect(connect).not.toHaveBeenCalled();
  });

  it('hands an authorized request, or any request without a token, to MCP', async () => {
    for (const token of ['secret', undefined, '']) {
      const response = await handleHttpRequest(
        request('/mcp', { authorization: 'Bearer secret' }),
        { token, connect },
      );
      expect(await response.text()).toBe('mcp');
    }
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
