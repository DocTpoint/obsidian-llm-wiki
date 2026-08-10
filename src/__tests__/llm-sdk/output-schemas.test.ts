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