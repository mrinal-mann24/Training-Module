import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import type { Submission } from '@/lib/db/queries/submissions';
import type { HintRequest } from '@/lib/db/queries/hint-requests';
import type { ConceptAttempt, ConceptMastery } from '@/lib/db/queries/mastery';
import type { QaMessage } from '@/lib/db/queries/qa-messages';
import type { ConceptTag } from '@/lib/schemas/exercise';
import { normalizeStoredCoaching, type Coaching } from '@/lib/schemas/coaching';
import { toHintStep } from '@/lib/schemas/hint';
import { extractTransactionDate } from '@/lib/documents/invoice-figures';
import { majorModuleProgress, overallProgress } from '@/lib/tutor/major-modules';

// The owner's view of one learner (2026-09-29): every month they were given,
// every upload, what it scored, the feedback and help they received, and how
// long each month took. Pure: scripts/learner-report.ts loads the rows and
// writes the file. Nothing here is shown to a learner, so scores and error
// codes (revoked from the learner's own role) are included.
//
// Not in the report because it is never stored: a refusal shown only in the
// browser at upload time (one file attached, a file that is not XML).

export type ReportLearner = {
  id: string;
  name: string;
  email: string | null;
  licenseMode: string;
  onboardedAt: string | null;
  aiaOnboardingCompletedAt: string | null;
};

export type ReportScoreRow = {
  submission_id: string;
  weighted_score: number | null;
  overall_result: string | null;
  tb_tie_out: boolean | null;
  error_codes: unknown;
  feedback_text: unknown;
  created_at: string;
};

export type ReportIssueRow = {
  message: string;
  status: string;
  admin_reply: string | null;
  exercise_id: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type ReportDocument = { docType: string; documentName: string };

export type LearnerReportInput = {
  learner: ReportLearner;
  generatedAt: string;
  exercises: ExerciseForLearner[];
  documentsByExercise: ReadonlyMap<string, ReportDocument[]>;
  submissions: Submission[];
  scores: ReportScoreRow[];
  hints: HintRequest[];
  attempts: ConceptAttempt[];
  questions: QaMessage[];
  issues: ReportIssueRow[];
  mastery: ReadonlyMap<ConceptTag, ConceptMastery>;
};

export type ReportUpload = {
  chance: number;
  uploadedAt: string;
  status: string;
  files: string[];
  rejections: string[];
  scorePercent: number | null;
  result: string | null;
  tieOut: boolean | null;
  errorCodes: { code: string; count: number }[];
  feedback: Coaching | null;
  passed: string[];
  failed: string[];
};

export type ReportMonth = {
  ordinal: number;
  exerciseId: string;
  title: string;
  kind: string;
  level: string;
  issuedAt: string;
  documentsOnly: boolean;
  transactionCount: number;
  documents: { docType: string; count: number }[];
  uploads: ReportUpload[];
  help: { step: number; concept: string; text: string; givenAt: string }[];
  questions: { question: string; answer: string; askedAt: string }[];
  issues: ReportIssueRow[];
  // Null when the learner has not uploaded (or not been scored) yet.
  msToFirstUpload: number | null;
  msToFinalScore: number | null;
};

export type LearnerReport = {
  learner: ReportLearner;
  generatedAt: string;
  progress: { percent: number; masteredCount: number; totalCount: number };
  modules: { title: string; masteredCount: number; totalCount: number; concepts: { tag: string; status: string }[] }[];
  months: ReportMonth[];
  otherIssues: ReportIssueRow[];
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The month a batch covers, read off its first dated transaction. A pack
// month carries its entries in files, so it is named by what it is.
function monthTitle(exercise: ExerciseForLearner): string {
  for (const transaction of exercise.transactions) {
    const date = extractTransactionDate(transaction.description);
    if (date) return `${MONTH_NAMES[date.monthIndex]} ${date.year}`;
  }
  const fromScenario = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/.exec(exercise.scenario);
  if (fromScenario) return `${fromScenario[1]} ${fromScenario[2]}`;
  return exercise.packFiles.length > 0 ? 'Authored pack' : 'Month not stated';
}

function countBy<T>(items: readonly T[], keyOf: (item: T) => string): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(keyOf(item), (counts.get(keyOf(item)) ?? 0) + 1);
  return [...counts.entries()].map(([key, count]) => ({ key, count }));
}

function errorCodesOf(raw: unknown): { code: string; count: number }[] {
  if (!Array.isArray(raw)) return [];
  const codes = raw.filter((value): value is string => typeof value === 'string');
  return countBy(codes, (code) => code)
    .map(({ key, count }) => ({ code: key, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

function elapsed(fromIso: string, toIso: string | undefined): number | null {
  if (!toIso) return null;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function buildLearnerReport(input: LearnerReportInput): LearnerReport {
  const exercises = [...input.exercises].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const scoreBySubmission = new Map(input.scores.map((row) => [row.submission_id, row]));
  const attemptsBySubmission = new Map<string, ConceptAttempt[]>();
  for (const attempt of input.attempts) {
    if (!attempt.submission_id) continue;
    const rows = attemptsBySubmission.get(attempt.submission_id) ?? [];
    rows.push(attempt);
    attemptsBySubmission.set(attempt.submission_id, rows);
  }

  // A question belongs to the month that was open when it was asked.
  const monthOpenAt = (iso: string): string | null => {
    let open: string | null = null;
    for (const exercise of exercises) {
      if (exercise.created_at <= iso) open = exercise.id;
    }
    return open;
  };

  const months = exercises.map((exercise, index): ReportMonth => {
    const uploads = input.submissions
      .filter((submission) => submission.exercise_id === exercise.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((submission): ReportUpload => {
        const score = scoreBySubmission.get(submission.id);
        const attempts = attemptsBySubmission.get(submission.id) ?? [];
        return {
          chance: (submission.correction_round ?? 0) + 1,
          uploadedAt: submission.created_at,
          status: submission.status,
          files: [submission.daybook_filename, submission.trialbalance_filename].filter((name): name is string => Boolean(name)),
          rejections: (submission.validity_errors ?? []).map((error) => error.message),
          scorePercent: score && score.weighted_score !== null ? Math.round(Number(score.weighted_score) * 1000) / 10 : null,
          result: score?.overall_result ?? null,
          tieOut: score?.tb_tie_out ?? null,
          errorCodes: errorCodesOf(score?.error_codes),
          feedback: score && score.feedback_text ? normalizeStoredCoaching(score.feedback_text) : null,
          passed: attempts.filter((attempt) => attempt.result === 'pass').map((attempt) => attempt.concept_tag),
          failed: attempts.filter((attempt) => attempt.result === 'fail').map((attempt) => attempt.concept_tag),
        };
      });
    const scored = uploads.filter((upload) => upload.status === 'scored');
    return {
      ordinal: index + 1,
      exerciseId: exercise.id,
      title: monthTitle(exercise),
      kind: exercise.kind,
      level: exercise.difficulty_level,
      issuedAt: exercise.created_at,
      documentsOnly: exercise.documentsOnly,
      transactionCount: exercise.expectedVoucherCount ?? exercise.transactions.length,
      documents: countBy(input.documentsByExercise.get(exercise.id) ?? [], (doc) => doc.docType).map(({ key, count }) => ({ docType: key, count })),
      uploads,
      help: input.hints
        .filter((hint) => hint.exercise_id === exercise.id)
        .map((hint) => ({
          step: toHintStep(hint.rung),
          concept: hint.hint_content?.concept_tag ?? '',
          text: hint.hint_content?.hint_text ?? '',
          givenAt: hint.created_at,
        })),
      questions: input.questions
        .filter((message) => monthOpenAt(message.created_at) === exercise.id)
        .map((message) => ({ question: message.question, answer: message.answer, askedAt: message.created_at })),
      issues: input.issues.filter((issue) => issue.exercise_id === exercise.id),
      msToFirstUpload: elapsed(exercise.created_at, uploads[0]?.uploadedAt),
      msToFinalScore: elapsed(exercise.created_at, scored[scored.length - 1]?.uploadedAt),
    };
  });

  const known = new Set(exercises.map((exercise) => exercise.id));
  const progress = overallProgress(input.mastery);
  return {
    learner: input.learner,
    generatedAt: input.generatedAt,
    progress: { percent: progress.percent, masteredCount: progress.masteredCount, totalCount: progress.totalCount },
    modules: majorModuleProgress(input.mastery).map((entry) => ({
      title: entry.majorModule.title,
      masteredCount: entry.masteredCount,
      totalCount: entry.totalCount,
      concepts: entry.concepts.map((concept) => ({ tag: concept.tag, status: concept.status })),
    })),
    months,
    otherIssues: input.issues.filter((issue) => !issue.exercise_id || !known.has(issue.exercise_id)),
  };
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return 'not yet';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return `${hours} hour${hours === 1 ? '' : 's'}${rest > 0 ? ` ${rest} min` : ''}`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `${days} day${days === 1 ? '' : 's'}${restHours > 0 ? ` ${restHours} hour${restHours === 1 ? '' : 's'}` : ''}`;
}

const INDIA_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatIndiaTime(iso: string | null): string {
  if (!iso) return 'not recorded';
  const time = Date.parse(iso);
  return Number.isFinite(time) ? `${INDIA_TIME.format(new Date(time))} IST` : iso;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const DOCUMENT_LABELS: Record<string, string> = {
  vendor_invoice: 'vendor invoice',
  sales_invoice: 'sales invoice or cash memo',
  bank_statement: 'bank statement',
  month_end_note: 'month-end notes sheet',
  sales_register: 'sales register',
};

const STATUS_LABELS: Record<string, string> = {
  validating: 'being checked',
  invalid: 'rejected before scoring',
  scoring: 'being scored',
  scored: 'scored',
};

const readable = (tag: string): string => tag.replace(/_/g, ' ');

function paragraphs(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '' : `<ul>${items.map((item) => `<li>${paragraphs(item)}</li>`).join('')}</ul>`;
}

function renderUpload(upload: ReportUpload): string {
  const facts = [
    `Uploaded ${formatIndiaTime(upload.uploadedAt)}`,
    STATUS_LABELS[upload.status] ?? upload.status,
    upload.scorePercent !== null ? `score ${upload.scorePercent}%` : null,
    upload.result ? `result ${upload.result}` : null,
    upload.tieOut === null ? null : upload.tieOut ? 'Trial Balance ties out' : 'Trial Balance does NOT tie out',
  ].filter((fact): fact is string => fact !== null);
  const parts = [`<h4>Chance ${upload.chance}</h4>`, `<p class="facts">${facts.map(escapeHtml).join(' · ')}</p>`];
  if (upload.files.length > 0) parts.push(`<p class="muted">Files: ${upload.files.map(escapeHtml).join(', ')}</p>`);
  if (upload.rejections.length > 0) parts.push(`<p class="label">Why it was rejected</p>${list(upload.rejections)}`);
  if (upload.errorCodes.length > 0) {
    parts.push(`<p class="label">Findings</p>${list(upload.errorCodes.map((entry) => `${readable(entry.code)}: ${entry.count}`))}`);
  }
  if (upload.passed.length > 0) parts.push(`<p class="label">Topics passed</p><p>${upload.passed.map(readable).map(escapeHtml).join(', ')}</p>`);
  if (upload.failed.length > 0) parts.push(`<p class="label">Topics failed</p><p>${upload.failed.map(readable).map(escapeHtml).join(', ')}</p>`);
  if (upload.feedback) {
    parts.push(
      '<div class="feedback"><p class="label">Feedback the learner read</p>',
      `<p>${paragraphs(upload.feedback.opening_line)}</p>`,
      upload.feedback.went_well.length > 0 ? `<p class="label">What went well</p>${list(upload.feedback.went_well)}` : '',
      upload.feedback.needs_work.length > 0 ? `<p class="label">What needs work</p>${list(upload.feedback.needs_work)}` : '',
      `<p>${paragraphs(upload.feedback.next_note)}</p></div>`,
    );
  }
  return `<section class="upload">${parts.join('')}</section>`;
}

function renderIssues(issues: readonly ReportIssueRow[]): string {
  return issues
    .map(
      (issue) =>
        `<div class="issue"><p class="facts">${escapeHtml(formatIndiaTime(issue.created_at))} · ${escapeHtml(issue.status)}</p><p>${paragraphs(issue.message)}</p>${
          issue.admin_reply ? `<p class="label">Reply</p><p>${paragraphs(issue.admin_reply)}</p>` : ''
        }</div>`,
    )
    .join('');
}

function renderMonth(month: ReportMonth): string {
  const documents = month.documents.map((entry) => `${entry.count} ${DOCUMENT_LABELS[entry.docType] ?? readable(entry.docType)}`).join(', ');
  const facts = [
    `Level ${month.level}`,
    month.kind,
    `${month.transactionCount} entries`,
    month.documentsOnly ? 'documents only' : 'entries given as text',
    `issued ${formatIndiaTime(month.issuedAt)}`,
  ];
  const parts = [
    `<h3>Month ${month.ordinal}: ${escapeHtml(month.title)}</h3>`,
    `<p class="facts">${facts.map(escapeHtml).join(' · ')}</p>`,
    documents ? `<p class="muted">Documents delivered: ${escapeHtml(documents)}</p>` : '',
    `<p class="muted">Time from issue to first upload: ${escapeHtml(formatDuration(month.msToFirstUpload))}. To the last scored upload: ${escapeHtml(formatDuration(month.msToFinalScore))}.</p>`,
    month.uploads.length === 0 ? '<p>No upload yet.</p>' : month.uploads.map(renderUpload).join(''),
  ];
  if (month.help.length > 0) {
    parts.push(
      '<h4>Help given</h4>',
      month.help
        .map(
          (help) =>
            `<div class="help"><p class="facts">Step ${help.step} · ${escapeHtml(readable(help.concept))} · ${escapeHtml(formatIndiaTime(help.givenAt))}</p><p>${paragraphs(help.text)}</p></div>`,
        )
        .join(''),
    );
  }
  if (month.questions.length > 0) {
    parts.push(
      '<h4>Questions asked</h4>',
      month.questions
        .map(
          (entry) =>
            `<div class="question"><p class="facts">${escapeHtml(formatIndiaTime(entry.askedAt))}</p><p class="label">Learner</p><p>${paragraphs(entry.question)}</p><p class="label">Tutor</p><p>${paragraphs(entry.answer)}</p></div>`,
        )
        .join(''),
    );
  }
  if (month.issues.length > 0) parts.push('<h4>Issues reported</h4>', renderIssues(month.issues));
  return `<article class="month">${parts.join('')}</article>`;
}

const STYLE = `
:root { --ink: #1c2230; --muted: #5d6678; --line: #d9dee8; --panel: #f6f8fb; --bad: #a3261c; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 16px 64px; background: #fff; color: var(--ink); font: 15px/1.55 "Segoe UI", Arial, sans-serif; }
main { max-width: 920px; margin: 0 auto; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 19px; margin: 36px 0 12px; border-bottom: 2px solid var(--line); padding-bottom: 6px; }
h3 { font-size: 17px; margin: 0 0 4px; }
h4 { font-size: 15px; margin: 18px 0 4px; }
p { margin: 4px 0; }
ul { margin: 4px 0 8px; padding-left: 20px; }
.muted, .facts { color: var(--muted); font-size: 13.5px; }
.label { font-weight: 600; font-size: 13px; text-transform: uppercase; letter-spacing: 0.03em; margin-top: 10px; color: var(--muted); }
.month { border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; margin: 0 0 18px; }
.upload, .help, .question, .issue { background: var(--panel); border-radius: 8px; padding: 10px 14px; margin: 10px 0; }
.feedback { border-left: 3px solid var(--line); padding-left: 12px; margin-top: 8px; }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); vertical-align: top; font-size: 14px; }
.note { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; color: var(--muted); font-size: 13.5px; }
@media print { body { padding: 0; } .month { break-inside: avoid-page; } }
`;

export function renderLearnerReportHtml(report: LearnerReport): string {
  const learner = report.learner;
  const moduleRows = report.modules
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.title)}</td><td>${entry.masteredCount} of ${entry.totalCount}</td><td>${entry.concepts
          .map((concept) => `${escapeHtml(readable(concept.tag))} (${escapeHtml(readable(concept.status))})`)
          .join(', ')}</td></tr>`,
    )
    .join('');
  const scoredMonths = report.months.filter((month) => month.msToFinalScore !== null);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Learner report: ${escapeHtml(learner.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>${escapeHtml(learner.name)}</h1>
<p class="muted">${escapeHtml(learner.email ?? 'no email on record')} · Tally licence: ${escapeHtml(learner.licenseMode)} · report made ${escapeHtml(formatIndiaTime(report.generatedAt))}</p>
<p class="muted">Signed up ${escapeHtml(formatIndiaTime(learner.onboardedAt))} · AI Accountant setup ${
    learner.aiaOnboardingCompletedAt ? `completed ${escapeHtml(formatIndiaTime(learner.aiaOnboardingCompletedAt))}` : 'not completed'
  }</p>

<h2>Progress</h2>
<p><strong>${report.progress.percent}% complete</strong>, ${report.progress.masteredCount} of ${report.progress.totalCount} topics mastered. ${report.months.length} month${
    report.months.length === 1 ? '' : 's'
  } issued, ${scoredMonths.length} scored.</p>
<table><thead><tr><th>Module</th><th>Mastered</th><th>Topics</th></tr></thead><tbody>${moduleRows}</tbody></table>

<h2>Month by month</h2>
${report.months.length === 0 ? '<p>No month has been issued yet.</p>' : report.months.map(renderMonth).join('\n')}

${report.otherIssues.length > 0 ? `<h2>Other issues reported</h2>${renderIssues(report.otherIssues)}` : ''}

<h2>What this report cannot show</h2>
<p class="note">Times are measured from the moment a month was issued, not from when the learner opened it: the platform does not record when work started. A refusal shown only on the upload screen (one file attached, a file that is not XML) is not stored, so it is not listed here.</p>
</main>
</body>
</html>
`;
}
