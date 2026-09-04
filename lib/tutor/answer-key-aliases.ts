import type { AnswerKey } from '@/lib/schemas/exercise';

// A learner's ledger names are accepted through the answer key's
// account_aliases. The authored April pack carries them ("Legal services",
// "Professional services" for "Legal & Professional Charges"), so Praveen's
// "Legal Services AC" and "Professional Services" ledgers scored as correct
// in April — and the generated September key, which carries no aliases,
// flagged the very same ledgers ACCOUNT_WRONG on MA/205 and SL/118
// (2026-09-04). A name the book accepted once stays accepted: at scoring
// time every key inherits the union of aliases any of the learner's keys
// has ever listed for the same canonical account.
function canonical(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function collectAccountAliases(keys: AnswerKey[]): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  for (const key of keys) {
    for (const entry of key.entries) {
      if (!entry.account_aliases?.length) continue;
      const id = canonical(entry.correct_account);
      const known = aliases.get(id) ?? [];
      for (const alias of entry.account_aliases) {
        if (!known.some((existing) => canonical(existing) === canonical(alias))) {
          known.push(alias);
        }
      }
      aliases.set(id, known);
    }
  }
  return aliases;
}

export function inheritAccountAliases(key: AnswerKey, learnerKeys: AnswerKey[]): AnswerKey {
  const inherited = collectAccountAliases(learnerKeys);
  if (inherited.size === 0) return key;
  return {
    ...key,
    entries: key.entries.map((entry) => {
      const extra = inherited.get(canonical(entry.correct_account));
      if (!extra?.length) return entry;
      const merged = [...(entry.account_aliases ?? [])];
      for (const alias of extra) {
        if (!merged.some((existing) => canonical(existing) === canonical(alias))) {
          merged.push(alias);
        }
      }
      return { ...entry, account_aliases: merged };
    }),
  };
}
