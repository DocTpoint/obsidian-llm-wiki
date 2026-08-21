// domain axis stage 3 (#568): the domain axis between note and page.
//
// Stage 2 gave the source page every tag of its note (a 1:1 projection, nothing
// to decide). An entity or concept page carries only an *excerpt* of what the
// source is about, so it carries only an excerpt of its tags — which one is the
// single step that needs semantics, and it rides as a field per extracted item
// in the extraction call, the one place where the source text is still in the
// window (#568).
//
// The model chooses, the code decides what counts: the choice is validated
// against the note's own tags — a value the note does not carry is dropped, not
// written. A model-proposed tag is born at one source and would hold vault-wide
// (the alias problem), so it is a candidate, not a fact; and the plugin holds no
// domain vocabulary to check it against. The empty set is a legitimate answer:
// a page without a reliable domain annotates better not at all than wrongly.
// Absence is not a signal — a note without tags sends no list and gets no field.

import type { CandidateCoverage } from '../types';

/** The frontmatter key: one constant, one place. */
export const DOMAINS_FIELD = 'domains';

/** The three observations the extraction may report per candidate (types.ts). */
export const COVERAGE_VALUES: ReadonlySet<string> = new Set<CandidateCoverage>(['defined', 'discussed', 'named']);

function fold(s: string): string {
  return s.normalize('NFC').trim().toLowerCase();
}

/**
 * The prompt block that names the note's domain tags as the allowed list for
 * this source. Empty string when the note has no tags — then the prompt is
 * byte-identical to a vault without the layer.
 */
export function buildDomainContext(noteTags: readonly string[]): string {
  const tags = noteTags.map(t => t.trim()).filter(Boolean);
  if (tags.length === 0) return '';
  return `\n**Domain tags of this source:** [${tags.join(', ')}]\n` +
    `(The note author's domain axis. For every extracted item, "domains" is the subset of THESE tags that describes what the item itself is or belongs to — not merely the context it appears in. Use [] when none applies. Never add a tag that is not in this list.)\n`;
}

export interface DomainSelection {
  /** Chosen values that the note carries, in the note's spelling, model order, deduplicated. */
  kept: string[];
  /** Chosen values the note does not carry — logged, never written. */
  rejected: string[];
}

/**
 * Validate the model's choice against the note's tags. Case- and
 * NFC-insensitive on the comparison, the note's spelling on the output.
 * Anything that is not a non-empty string is ignored.
 */
export function selectDomains(chosen: unknown, noteTags: readonly string[]): DomainSelection {
  const allowed = new Map<string, string>();
  for (const t of noteTags) {
    const v = t.trim();
    if (v && !allowed.has(fold(v))) allowed.set(fold(v), v);
  }
  const kept: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(chosen)) return { kept, rejected };
  for (const raw of chosen) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = fold(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const canonical = allowed.get(key);
    if (canonical) kept.push(canonical);
    else rejected.push(raw.trim());
  }
  return { kept, rejected };
}
