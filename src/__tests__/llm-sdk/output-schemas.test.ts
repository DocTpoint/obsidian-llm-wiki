// output-schemas.test.ts
//
// v1.26.3 PATCH Phase B: Zod schema validation tests.
//
// Each schema has at least 2 tests:
//   - happy-path parse (valid input → typed object)
//   - missing-field parse failure (Zod throws)
//
// The "happy path" tests pin the contract that callers rely on
// (`result.output ?? parseJsonResponse(text)` produces a typed
// object with the expected shape). The "missing field" tests pin
// the runtime validation that Zod provides — without it, callers
// would silently get undefined fields and crash downstream.

import { describe, it, expect } from 'vitest';
import {
  SeedSelectorSchema,
  QueryKeywordsSchema,
  MergeTriageSchema,
  LinkOrphanSchema,
  FixDeadLinkSchema,
  QueryViewValueSchema,
  SourceAnalysisLLMSchema,
  LemmaClassifyLLMSchema,
  ConversationDedupStatusLLMSchema,
  DedupResultLLMSchema,
  SchemaSuggestionLLMSchema,
  PathResolutionLLMSchema,
  AliasGenerationLLMSchema,
  TagFixLLMSchema,
  WelcomeTranslationLLMSchema,
} from '../../llm-sdk/output-schemas';

describe('output-schemas (Phase B)', () => {
  describe('SeedSelectorSchema', () => {
    it('parses valid {seeds: string[]}', () => {
      const r = SeedSelectorSchema.parse({ seeds: ['a.md', 'b.md'] });
      expect(r.seeds).toEqual(['a.md', 'b.md']);
    });
    it('rejects missing seeds', () => {
      expect(() => SeedSelectorSchema.parse({})).toThrow();
    });
    it('rejects non-string seeds element', () => {
      expect(() => SeedSelectorSchema.parse({ seeds: [1, 2] })).toThrow();
    });
  });

  describe('QueryKeywordsSchema', () => {
    it('parses valid {keywords: string[]}', () => {
      const r = QueryKeywordsSchema.parse({ keywords: ['wiki', 'graph', 'tier-2'] });
      expect(r.keywords).toEqual(['wiki', 'graph', 'tier-2']);
    });
    it('rejects missing keywords', () => {
      expect(() => QueryKeywordsSchema.parse({})).toThrow();
    });
  });

  describe('MergeTriageSchema', () => {
    it('parses valid {strategy, items?, reason?}', () => {
      const r = MergeTriageSchema.parse({
        strategy: 'insert',
        items: [{ kind: 'paragraph', content: 'foo', target_section: 'Intro', reason: 'new info' }],
        reason: 'rationale',
      });
      expect(r.strategy).toBe('insert');
      expect(r.items?.[0].content).toBe('foo');
    });
    it('accepts optional items / reason (mirrors existing cast permissiveness)', () => {
      const r = MergeTriageSchema.parse({ strategy: 'reject' });
      expect(r.strategy).toBe('reject');
      expect(r.items).toBeUndefined();
      expect(r.reason).toBeUndefined();
    });
    it('rejects missing strategy (required for caller branching)', () => {
      expect(() => MergeTriageSchema.parse({})).toThrow();
    });
  });

  describe('LinkOrphanSchema', () => {
    it('parses valid {related_pages}', () => {
      const r = LinkOrphanSchema.parse({
        related_pages: [
          { page_path: 'a.md', link_text: 'A', link_target: 'a.md' },
        ],
      });
      expect(r.related_pages?.[0].page_path).toBe('a.md');
    });
    it('accepts missing related_pages (caller returns [] in that case)', () => {
      const r = LinkOrphanSchema.parse({});
      expect(r.related_pages).toBeUndefined();
    });
  });

  describe('FixDeadLinkSchema', () => {
    it('parses valid {action, correct_link}', () => {
      const r = FixDeadLinkSchema.parse({ action: 'correct', correct_link: '[[real-target]]' });
      expect(r.action).toBe('correct');
      expect(r.correct_link).toBe('[[real-target]]');
    });
    it('parses valid {action, stub_title, stub_type}', () => {
      const r = FixDeadLinkSchema.parse({ action: 'stub', stub_title: 'NewPage', stub_type: 'topic' });
      expect(r.action).toBe('stub');
      expect(r.stub_title).toBe('NewPage');
    });
    it('accepts missing action (caller branches on it)', () => {
      const r = FixDeadLinkSchema.parse({});
      expect(r.action).toBeUndefined();
    });
  });

  describe('QueryViewValueSchema', () => {
    it('parses valid {valuable, reason}', () => {
      const r = QueryViewValueSchema.parse({ valuable: true, reason: 'has Q&A pattern' });
      expect(r.valuable).toBe(true);
      expect(r.reason).toBe('has Q&A pattern');
    });
    it('accepts missing valuable (caller defaults to skip)', () => {
      const r = QueryViewValueSchema.parse({});
      expect(r.valuable).toBeUndefined();
    });
  });
});

describe('output-schemas (Phase B expanded scope)', () => {
  describe('SourceAnalysisLLMSchema', () => {
    it('parses a full SourceAnalysis with entities + concepts + mentions_with_provenance', () => {
      const r = SourceAnalysisLLMSchema.parse({
        source_title: 'Submit your plugin',
        summary: 'A wiki page about plugin submission',
        entities: [{
          name: 'GitHub',
          type: 'organization',
          aliases: ['github.com'],
          summary: 'Code hosting platform',
          mentions_in_source: ['If you need to use GitHub'],
          mentions_with_provenance: [{
            quote: 'If you need to use GitHub',
            translation: '如果你需要使用 GitHub',
            source_path: 'foo.md',
            source_slug: 'foo',
            extracted_at: '2026-07-05T00:00:00Z',
          }],
          related_entities: [],
          related_concepts: [],
        }],
        concepts: [{
          name: 'Semantic Versioning',
          type: 'standard',
          summary: 'Versioning scheme',
          mentions_in_source: ['follows Semantic Versioning'],
          mentions_with_provenance: [],
          related_concepts: [],
        }],
        related_pages: ['foo.md'],
        key_points: ['submit a PR'],
      });
      expect(r.entities?.[0].name).toBe('GitHub');
      expect(r.entities?.[0].mentions_with_provenance?.[0].translation).toBe('如果你需要使用 GitHub');
      expect(r.concepts?.[0].name).toBe('Semantic Versioning');
    });

    it('accepts an empty object (graceful fallback)', () => {
      const r = SourceAnalysisLLMSchema.parse({});
      expect(r.entities).toBeUndefined();
      expect(r.source_title).toBeUndefined();
    });

    it('passes through extra unknown fields (forward-compat)', () => {
      const r = SourceAnalysisLLMSchema.parse({
        source_title: 'X',
        confidence: 0.95, // model added this on its own
      });
      expect((r as Record<string, unknown>).confidence).toBe(0.95);
    });

    it('rejects entities item missing name (required structural field)', () => {
      expect(() => SourceAnalysisLLMSchema.parse({
        entities: [{ type: 'person' }],
      })).toThrow();
    });
  });

  describe('LemmaClassifyLLMSchema', () => {
    it('parses {kind: entity} and {kind: concept}', () => {
      expect(LemmaClassifyLLMSchema.parse({ kind: 'entity' }).kind).toBe('entity');
      expect(LemmaClassifyLLMSchema.parse({ kind: 'concept' }).kind).toBe('concept');
    });
    it('passes through any kind string (widening — caller filters)', () => {
      expect(LemmaClassifyLLMSchema.parse({ kind: 'page' }).kind).toBe('page');
    });
    it('rejects missing kind (required)', () => {
      expect(() => LemmaClassifyLLMSchema.parse({})).toThrow();
    });
  });

  describe('ConversationDedupStatusLLMSchema', () => {
    it('parses {status}', () => {
      expect(ConversationDedupStatusLLMSchema.parse({ status: 'entirely_new' }).status).toBe('entirely_new');
    });
    it('accepts missing status (caller defaults)', () => {
      const r = ConversationDedupStatusLLMSchema.parse({});
      expect(r.status).toBeUndefined();
    });
  });

  describe('DedupResultLLMSchema', () => {
    it('parses {duplicates: [{target, source, reason}]}', () => {
      const r = DedupResultLLMSchema.parse({
        duplicates: [{ target: 'a.md', source: 'b.md', reason: 'same concept' }],
      });
      expect(r.duplicates?.[0].target).toBe('a.md');
    });
    it('accepts missing duplicates (legitimate "no duplicates")', () => {
      const r = DedupResultLLMSchema.parse({});
      expect(r.duplicates).toBeUndefined();
    });
  });

  describe('SchemaSuggestionLLMSchema', () => {
    it('parses full {changes_needed, new_schema_body, suggestions}', () => {
      const r = SchemaSuggestionLLMSchema.parse({
        changes_needed: true,
        new_schema_body: '---\n---\n\n# Schema',
        suggestions: 'Add new tag',
      });
      expect(r.changes_needed).toBe(true);
      expect(r.new_schema_body).toContain('# Schema');
    });
    it('accepts any single optional field', () => {
      expect(SchemaSuggestionLLMSchema.parse({ suggestions: 'Only a suggestion' }).suggestions).toBe('Only a suggestion');
    });
    it('accepts empty object (no proposal)', () => {
      const r = SchemaSuggestionLLMSchema.parse({});
      expect(r.changes_needed).toBeUndefined();
    });
  });

  describe('PathResolutionLLMSchema', () => {
    it('parses {match: true, path}', () => {
      const r = PathResolutionLLMSchema.parse({ match: true, path: 'wiki/entities/foo.md' });
      expect(r.match).toBe(true);
      expect(r.path).toBe('wiki/entities/foo.md');
    });
    it('parses {match: false} (no path needed)', () => {
      const r = PathResolutionLLMSchema.parse({ match: false });
      expect(r.match).toBe(false);
      expect(r.path).toBeUndefined();
    });
    it('accepts path: null (LLM may emit null for no-match)', () => {
      const r = PathResolutionLLMSchema.parse({ match: false, path: null });
      expect(r.path).toBeNull();
    });
    it('accepts empty object (caller falls back to slugPath)', () => {
      const r = PathResolutionLLMSchema.parse({});
      expect(r.match).toBeUndefined();
    });
  });

  describe('AliasGenerationLLMSchema', () => {
    it('parses {aliases: string[]}', () => {
      const r = AliasGenerationLLMSchema.parse({ aliases: ['alias1', 'alias2'] });
      expect(r.aliases).toEqual(['alias1', 'alias2']);
    });
    it('accepts missing aliases (no proposals)', () => {
      const r = AliasGenerationLLMSchema.parse({});
      expect(r.aliases).toBeUndefined();
    });
  });

  describe('TagFixLLMSchema', () => {
    it('parses {tags: string[]}', () => {
      const r = TagFixLLMSchema.parse({ tags: ['wiki', 'guide'] });
      expect(r.tags).toEqual(['wiki', 'guide']);
    });
    it('accepts empty tags array (no valid matches)', () => {
      const r = TagFixLLMSchema.parse({ tags: [] });
      expect(r.tags).toEqual([]);
    });
    it('accepts missing tags', () => {
      const r = TagFixLLMSchema.parse({});
      expect(r.tags).toBeUndefined();
    });
  });

  describe('WelcomeTranslationLLMSchema', () => {
    it('parses {translated: <long markdown body>}', () => {
      const body = '---\ntitle: 欢迎\n---\n\n# 欢迎\n\nThis is the welcome body.';
      const r = WelcomeTranslationLLMSchema.parse({ translated: body });
      expect(r.translated).toBe(body);
    });
    it('passes through extra fields', () => {
      const r = WelcomeTranslationLLMSchema.parse({
        translated: '# 欢迎',
        notes: 'preserved frontmatter',
      });
      expect(r.translated).toBe('# 欢迎');
      expect((r as Record<string, unknown>).notes).toBe('preserved frontmatter');
    });
    it('rejects missing translated (required)', () => {
      expect(() => WelcomeTranslationLLMSchema.parse({})).toThrow();
    });
  });
});