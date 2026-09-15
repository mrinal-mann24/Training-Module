import { z } from 'zod';
import { ISSUE_MESSAGE_MAX_LENGTH } from '@/lib/chat/issue-limits';

// Control characters other than tab, newline and carriage return. Postgres
// text rejects NUL outright, so a pasted NUL would otherwise fail the insert.
function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    })
    .join('');
}

// Input boundary for the reportIssue Server Action. The message is cleaned
// and trimmed before the length rules run, so whitespace-only text is empty
// and the 2000 limit counts what is actually stored.
export const ReportIssueInputSchema = z.object({
  message: z
    .string()
    .transform(stripControlCharacters)
    .pipe(z.string().trim().min(1).max(ISSUE_MESSAGE_MAX_LENGTH)),
});

export const IssueStatusSchema = z.enum(['open', 'resolved']);

export type IssueStatus = z.infer<typeof IssueStatusSchema>;
