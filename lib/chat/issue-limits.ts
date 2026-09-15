// Shared by the server-side schema (lib/schemas/learner-issue.ts) and the
// chat's issue box, kept in its own file so the client bundle picks up the
// number without pulling in zod. Mirrors the learner_issues.message check
// constraint (20260915140000_learner_issues.sql).
export const ISSUE_MESSAGE_MAX_LENGTH = 2000;
