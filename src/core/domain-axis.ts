// domain axis stage 3 (#568): the domain axis between note and page.
//
// Stage 2 gave the source page every tag of its note (a 1:1 projection, nothing
// to decide). An entity or concept page carries only an *excerpt* of what the
// source is about — which tags describe the extracted item is the single step
// that needs semantics, and it rides as a field per extracted item in the
// extraction call, the one place where the source text is still in the window.
//
// The allowed list is the vault's tag vocabulary — every tag any note carries —
// not the single note's tags. The per-note list looked safer but failed twice
// in one measured run (#568): an item whose kind lies athwart the note (a gene
// in a disease note) can never receive its tag, which made 43% of the model's
// answers empty by construction; and the strict full-string comparison threw
// away correct answers written in the bare `Wert` spelling. One list, collected
// from the notes themselves, rendered into the prompt and used for validation:
// the model chooses, the code folds the spelling and checks membership. A value
// no note carries is still dropped, not written — a model-proposed tag is a
// candidate, not a fact. The empty set stays a legitimate answer: a page
// without a reliable domain annotates better not at all than wrongly.

import type { App } from 'obsidian';
import type { CandidateCoverage } from '../types';
import { isInFolderScope } from './folder-scope';

/** The frontmatter key: one constant, one place. */
export const DOMAINS_FIELD = 'domains';

/** The three observations the extraction may report per candidate (types.ts). */
export const COVERAGE_VALUES: ReadonlySet<string> = new Set<CandidateCoverage>(['defined', 'discussed', 'named']);

function fold(s: string): string {
  return s.normalize('NFC').trim().toLowerCase();
}

/**
 * Union two domain lists the way `selectDomains` compares them: keyed on
 * `fold` (NFC + trim + lowercase), first spelling wins, insertion order
 * preserved, empty and non-string entries dropped.
 *
 * Every writer that merges `domains:` shares this, because the axis has one
 * notion of "the same value" and it is the validator's. Raw string equality
 * at a merge site re-admits exactly what `selectDomains` folds away: a page
 * merged from two sources kept `Thema/Ernährung` and `thema/ernährung` side
 * by side, one value written twice. Trimming both sides matters for the same
 * reason — the existing side comes off a parsed file, where a stray space
 * survives, while the incoming side is canonical only as long as every caller
 * runs it through the validator first.
 */
export function unionDomains(
  existing: readonly unknown[] | undefined,
  incoming: readonly unknown[] | undefined,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of [existing, incoming]) {
    for (const raw of list ?? []) {
      if (typeof raw !== 'string') continue;
      const v = raw.trim();
      if (!v) continue;
      const k = fold(v);
      if (seen.has(k)) continue;
      seen.add(k);
      merged.push(v);
    }
  }
  return merged;
}

/**
 * The vault's domain vocabulary: every frontmatter tag of every markdown file
 * outside the wiki folder, first spelling wins, sorted for a stable prompt.
 * Reads the metadata cache only — cheap enough to call per ingested note, and
 * both hosts (Obsidian and the CLI shim) serve the same API.
 */
export function collectDomainVocabulary(app: App, wikiFolder: string): string[] {
  // The boundary test is `isInFolderScope`, not a hand-rolled prefix: an empty
  // `wikiFolder` is the vault root there, so every file is a wiki page and the
  // vocabulary is empty — which `buildDomainContext` already renders as the
  // no-layer prompt. Hand-rolled, `'' + '/'` was `'/'`, a prefix no
  // vault-relative path carries, so the exclusion silently did nothing and the
  // wiki's own page tags fed back in as vocabulary — the axis would then offer
  // the model values that came from its own output.
  const seen = new Map<string, string>();
  for (const f of app.vault.getMarkdownFiles()) {
    if (isInFolderScope(f.path, wikiFolder, false)) continue;
    const raw = (app.metadataCache.getFileCache(f)?.frontmatter as { tags?: unknown } | undefined)?.tags;
    if (!Array.isArray(raw)) continue;
    for (const t of raw) {
      if (typeof t !== 'string') continue;
      const v = t.trim();
      if (!v) continue;
      const k = fold(v);
      if (!seen.has(k)) seen.set(k, v);
    }
  }
  return [...seen.values()].sort((a, b) => fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : 0);
}

/**
 * The prompt block that names the vault's vocabulary as the allowed list.
 * Empty string when no note carries a tag — then the prompt is byte-identical
 * to a vault without the layer. The block is the same for every note, so it
 * lives in the static prefix without breaking the prompt cache.
 */
export function buildDomainContext(vocabulary: readonly string[]): string {
  const tags = vocabulary.map(t => t.trim()).filter(Boolean);
  if (tags.length === 0) return '';
  return `\n**Domain tag vocabulary of this vault:** [${tags.join(', ')}]\n` +
    `(The note authors' domain axis. For every extracted item, "domains" is the subset of THESE tags that describes what the item itself is or belongs to — not merely the context it appears in. Copy the exact spelling from the list, including the part before the "/". Use [] when none applies. Never add a tag that is not in this list.)\n`;
}

export interface DomainSelection {
  /** Chosen values the vocabulary carries, in the vocabulary's spelling, model order, deduplicated. */
  kept: string[];
  /** Chosen values the vocabulary does not carry — logged, never written. */
  rejected: string[];
}

/**
 * Validate the model's choice against the vocabulary. Case- and NFC-insensitive
 * on the comparison, the vocabulary's spelling on the output. A bare answer
 * without the group prefix (`Mikrobiom` for `Thema/Mikrobiom`) is accepted iff
 * exactly one vocabulary entry has that value part — the measured failure mode
 * is the model dropping the prefix, and the unique match keeps the repair
 * deterministic. Anything that is not a non-empty string is ignored.
 */
export function selectDomains(chosen: unknown, vocabulary: readonly string[]): DomainSelection {
  const allowed = new Map<string, string>();
  const byValuePart = new Map<string, string[]>();
  for (const t of vocabulary) {
    const v = t.trim();
    if (!v || allowed.has(fold(v))) continue;
    allowed.set(fold(v), v);
    const slash = v.indexOf('/');
    if (slash > 0 && slash < v.length - 1) {
      const key = fold(v.slice(slash + 1));
      byValuePart.set(key, [...(byValuePart.get(key) ?? []), v]);
    }
  }
  const kept: string[] = [];
  const rejected: string[] = [];
  const keptSeen = new Set<string>();
  const rejectedSeen = new Set<string>();
  if (!Array.isArray(chosen)) return { kept, rejected };
  for (const raw of chosen) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = fold(raw);
    let canonical = allowed.get(key);
    if (!canonical && !raw.includes('/')) {
      const candidates = byValuePart.get(key);
      if (candidates && candidates.length === 1) canonical = candidates[0];
    }
    if (canonical) {
      const ck = fold(canonical);
      if (!keptSeen.has(ck)) { keptSeen.add(ck); kept.push(canonical); }
    } else if (!rejectedSeen.has(key)) {
      rejectedSeen.add(key);
      rejected.push(raw.trim());
    }
  }
  return { kept, rejected };
}

/**
 * Tag-Achse Stufe 4 (S137): the belonging offer is the union of what the
 * notes carry (harvested) and the curated nested values of the active custom
 * vocabulary. The settings list is where new values are born before any note
 * carries them; only nested (`Gruppe/Wert`) entries join — the flat base
 * types are identity answers, not belonging values. Fold-deduped, harvested
 * spelling wins.
 */
export function extendVocabulary(harvested: string[], settingsTags: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const v of harvested) seen.set(fold(v), v);
  for (const t of settingsTags) {
    const v = t.trim();
    if (!v || !v.includes('/')) continue;
    const k = fold(v);
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen.values()].sort((a, b) => fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : 0);
}
