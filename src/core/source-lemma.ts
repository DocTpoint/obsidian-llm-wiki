// source-lemma.ts — does the source note's own topic have a node?
//
// `analyzeSource` extracts entities/concepts *from* a text. That the text is
// itself *about* something is not a category of the extraction prompt, so the
// note's own lemma is regularly absent from both lists — the page a reader
// would look for first is the one that does not get written.
//
// This module answers the *whether* deterministically: no IO, no LLM, no
// side effects. The caller owns the *what* (type choice, body). Every helper
// is a pure function so the decision can be unit-tested without a vault.
//
// The same matching logic answers a second question ("is this source the one
// the page is named after?"), so it is exported rather than inlined.

import { computeSlug } from './slug';

/** An extracted candidate as far as lemma matching is concerned. */
export interface NamedCandidate {
  name: string;
  aliases?: string[];
}

/** What the caller should do about the source note's own lemma. */
export type LemmaDecision =
  | { action: 'skip'; reason: 'no-title' | 'already-extracted' | 'domain-container' }
  | { action: 'add'; name: string };

/**
 * Slug keys a name claims: the name itself plus any aliases.
 *
 * `computeSlug` is used without `preserveCase` so keys stay comparable
 * regardless of the user's slugCase setting — the same rule the conflict
 * resolver follows.
 */
export function slugKeys(name: string, aliases: readonly string[] = []): Set<string> {
  const keys = new Set<string>();
  if (name && name.trim().length > 0) keys.add(computeSlug(name));
  for (const alias of aliases) {
    if (typeof alias === 'string' && alias.trim().length > 0) keys.add(computeSlug(alias));
  }
  return keys;
}

/**
 * True when any extracted candidate already claims one of `keys` — by its own
 * name or by an alias the extraction pre-generated.
 *
 * This is the S45 "Papain" guard: the lemma is frequently extracted on its
 * own, and re-adding it would create a duplicate candidate for a page that is
 * already on its way.
 */
export function isLemmaExtracted(
  keys: ReadonlySet<string>,
  extracted: readonly NamedCandidate[],
): boolean {
  for (const item of extracted) {
    for (const key of slugKeys(item.name, item.aliases ?? [])) {
      if (keys.has(key)) return true;
    }
  }
  return false;
}

/**
 * True when the note is a domain container rather than a topic — a note named
 * after a field of study, whose density of terms is the point and whose own
 * name is not a lemma the wiki wants ("Neurology", "Pharmacology").
 *
 * Deliberately driven by the user's *configured* tag vocabulary rather than a
 * hand-written word list: the settings already enumerate the domains this
 * vault recognizes, so the rule carries no separate list to drift out of sync.
 * A vault with no domain tags configured simply never skips for this reason.
 */
export function isDomainContainer(
  keys: ReadonlySet<string>,
  domainTags: readonly string[],
): boolean {
  for (const tag of domainTags) {
    if (typeof tag !== 'string' || tag.trim().length === 0) continue;
    if (keys.has(computeSlug(tag))) return true;
  }
  return false;
}

/** Split a comma-separated settings tag list into trimmed, non-empty entries. */
export function parseTagList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
}

/**
 * Decide whether the source note's own lemma must be added as a candidate.
 *
 * Conservative by construction: every branch that is not clearly "missing and
 * wanted" returns `skip`. A node that is not created costs nothing; a wrongly
 * created one is permanent.
 */
export function decideSourceLemma(params: {
  /** Title the analysis recorded for the source (falls back to the filename). */
  sourceTitle: string | null | undefined;
  /** Curated `aliases:` from the source note's frontmatter (Issue #185). */
  sourceAliases?: readonly string[];
  entities: readonly NamedCandidate[];
  concepts: readonly NamedCandidate[];
  /** Configured domain tag vocabulary, already split. */
  domainTags?: readonly string[];
}): LemmaDecision {
  const title = (params.sourceTitle ?? '').trim();
  if (title.length === 0) return { action: 'skip', reason: 'no-title' };

  const keys = slugKeys(title, params.sourceAliases ?? []);
  if (keys.size === 0) return { action: 'skip', reason: 'no-title' };

  if (isDomainContainer(keys, params.domainTags ?? [])) {
    return { action: 'skip', reason: 'domain-container' };
  }
  if (isLemmaExtracted(keys, params.entities) || isLemmaExtracted(keys, params.concepts)) {
    return { action: 'skip', reason: 'already-extracted' };
  }
  return { action: 'add', name: title };
}
