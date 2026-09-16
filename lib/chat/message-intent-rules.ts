import type { TextPartType } from '@/lib/schemas/exercise';

export type RuleIntent = 'question' | 'answer' | 'unclear';

export type RuleVerdict = {
  intent: RuleIntent;
  // Which signals fired, for the trace log and tests. Never shown to learners.
  signals: string[];
};

// Q&A refuses questions longer than this (askQuestion's existing cap), so a
// longer message can only be filed as an answer. The learner still confirms,
// and can tap "It's a question" instead.
const QA_MAX_CHARS = 2000;

const ANSWER_POSTING_VERB =
  /\b(i|we) (have |had )?(posted|debited|credited|recorded|booked|passed|entered|treated|classified|deducted|claimed|capitali[sz]ed|reversed)\b/;
const ANSWER_REASONING = /\b(because|since|as per|hence|therefore|due to|the reason)\b/;
const DR_CR_TOKEN = /\b(dr|cr|debit|credit)\b/g;
const REVIEW_VERDICT =
  /\b(is wrong|incorrect|correct|should (be|have been)|looks (fine|good|right|off|wrong)|all (good|fine|correct|ok)|no (errors?|issues?|mistakes?|anomal(y|ies))|missing|duplicate|wrongly)\b/;
const NUMBERED_LINE = /^\s*(\d+[.)]|entry \d+)/gim;

const QUESTION_OPENERS = new Set([
  'what', 'which', 'why', 'how', 'when', 'where', 'who',
  'is', 'are', 'can', 'could', 'should', 'do', 'does', 'did', 'will', 'would',
]);
const QUESTION_PHRASE =
  /(i don'?t understand|not sure|confused|help me|can you|could you|tell me|how do i|where do i|should i|do i need|meaning of)/;
const GREETING_OR_ACK = /^(hi|hello|hey|ok|okay|thanks|thank you|thx|got it|cool|sure|yes|no|done)\b/;
const HELP_WORD = /\b(help|hint|stuck)\b/;

function normalize(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * First pass of Smart Send: decides from the text alone whether a message
 * typed while an explain/review part is pending is a question, an answer,
 * or unclear. Deliberately conservative: anything mixed or bare is
 * "unclear" and goes to the LLM tie-break (lib/tutor/classify-message-intent.ts).
 * An "answer" verdict never files anything by itself; the learner confirms.
 */
export function classifyByRules(text: string, part: TextPartType): RuleVerdict {
  const normalized = normalize(text);
  const words = normalized.length === 0 ? [] : normalized.split(' ');
  const signals: string[] = [];

  const postingVerb = ANSWER_POSTING_VERB.test(normalized);
  const reasoning = ANSWER_REASONING.test(normalized);
  const drCrTokens = normalized.match(DR_CR_TOKEN)?.length ?? 0;
  const reviewVerdict =
    part === 'review_text' &&
    (REVIEW_VERDICT.test(normalized) || (text.match(NUMBERED_LINE)?.length ?? 0) >= 2);

  if (postingVerb) signals.push('answer:posting-verb');
  if (reasoning) signals.push('answer:reasoning');
  if (drCrTokens >= 3) signals.push('answer:dr-cr-lines');
  if (reviewVerdict) signals.push('answer:review-verdict');
  const answerScore = (postingVerb ? 1 : 0) + (reasoning ? 1 : 0) + (drCrTokens >= 3 ? 2 : 0) + (reviewVerdict ? 1 : 0);

  const endsWithQuestionMark = normalized.endsWith('?');
  const opensAsQuestion = QUESTION_OPENERS.has(words[0] ?? '');
  const asksForHelp = QUESTION_PHRASE.test(normalized);
  if (endsWithQuestionMark) signals.push('question:question-mark');
  if (opensAsQuestion) signals.push('question:opener');
  if (asksForHelp) signals.push('question:help-phrase');
  const questionSignal = endsWithQuestionMark || opensAsQuestion || asksForHelp;

  if (words.length === 0 || (answerScore === 0 && normalized.length < 25 && GREETING_OR_ACK.test(normalized))) {
    return { intent: 'question', signals: [...signals, 'rule:empty-or-greeting'] };
  }
  // One or two words: a plea for help is a question, but "Looks fine" on a
  // review or "Bank charges" on an explanation may be the whole answer, so
  // anything else this short goes to the tie-break, never straight to Q&A.
  if (words.length <= 2 && answerScore === 0) {
    return questionSignal || HELP_WORD.test(normalized)
      ? { intent: 'question', signals: [...signals, 'rule:short-question'] }
      : { intent: 'unclear', signals: [...signals, 'rule:short-unclear'] };
  }
  if (text.length > QA_MAX_CHARS) {
    return { intent: 'answer', signals: [...signals, 'rule:too-long-for-qa'] };
  }
  if (answerScore >= 2 && !questionSignal) {
    return { intent: 'answer', signals: [...signals, 'rule:answer-signals'] };
  }
  if (words.length >= 60 && !normalized.includes('?') && !asksForHelp) {
    return { intent: 'answer', signals: [...signals, 'rule:long-statement'] };
  }
  if (questionSignal && answerScore === 0 && words.length <= 40) {
    return { intent: 'question', signals: [...signals, 'rule:question-signals'] };
  }
  return { intent: 'unclear', signals };
}
