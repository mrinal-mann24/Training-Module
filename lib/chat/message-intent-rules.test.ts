import { describe, expect, it } from 'vitest';
import { classifyByRules, type RuleIntent } from './message-intent-rules';
import type { TextPartType } from '@/lib/schemas/exercise';

const LONG_EXPLANATION = Array.from(
  { length: 35 },
  (_, index) => `Entry ${index + 1} follows the purchase register and the vendor bill on record`,
).join(' and ');

const PASTED_RULEBOOK = `${'Rule 13 covers recruitment charges and the related TDS treatment for professional services. '.repeat(26)}can you explain this section?`;

const CASES: Array<{ name: string; part: TextPartType; text: string; expected: RuleIntent }> = [
  { name: 'bare ledger question', part: 'explain_text', text: 'which ledger for bank charges', expected: 'question' },
  {
    name: 'explanation with a posting verb and a reason',
    part: 'explain_text',
    text: 'I posted rent to expenses because it is a monthly cost, not an asset',
    expected: 'answer',
  },
  { name: 'one-word acknowledgement', part: 'explain_text', text: 'ok', expected: 'question' },
  { name: 'short thanks', part: 'review_text', text: 'thanks, got it', expected: 'question' },
  { name: 'yes/no question', part: 'explain_text', text: 'Is TDS applicable on the rent to Mr Sharma?', expected: 'question' },
  {
    name: 'question-shaped explanation',
    part: 'explain_text',
    text: 'Why did I post freight separately? Because freight inward is a direct expense under Rulebook 7.',
    expected: 'unclear',
  },
  { name: 'Dr/Cr lines', part: 'explain_text', text: 'Dr Rent 25,000 Cr TDS on Rent 2,500 Cr Landlord 22,500', expected: 'answer' },
  { name: 'confusion about the task', part: 'explain_text', text: 'I don’t understand what explain the entry means', expected: 'question' },
  {
    name: 'answer that asks for a check',
    part: 'explain_text',
    text: 'is this correct? I debited Purchases and credited the vendor because it was on credit',
    expected: 'unclear',
  },
  { name: 'long explanation with no question mark', part: 'explain_text', text: LONG_EXPLANATION, expected: 'answer' },
  { name: 'paste over the Q&A limit, even when it asks for help', part: 'explain_text', text: PASTED_RULEBOOK, expected: 'answer' },
  { name: 'two-word review verdict', part: 'review_text', text: 'Looks fine', expected: 'unclear' },
  { name: 'two-word all-correct review', part: 'review_text', text: 'All correct', expected: 'unclear' },
  { name: 'one-word plea for help', part: 'explain_text', text: 'help', expected: 'question' },
  { name: 'two-word statement', part: 'explain_text', text: 'Rent wrong', expected: 'unclear' },
  {
    name: 'review verdicts',
    part: 'review_text',
    text: 'Entry 3 is wrong, should be IGST since the buyer is in Karnataka. Entry 5 looks fine.',
    expected: 'answer',
  },
  { name: 'where to type', part: 'explain_text', text: 'where do I type my explanation', expected: 'question' },
  { name: 'bare statement', part: 'explain_text', text: 'Bank charges go under Indirect Expenses', expected: 'unclear' },
  {
    name: 'greeting mixed with work and a question',
    part: 'explain_text',
    text: "hi, I posted everything but I'm confused, should the fees be 194J?",
    expected: 'unclear',
  },
];

describe('classifyByRules', () => {
  it.each(CASES)('$name -> $expected', ({ part, text, expected }) => {
    expect(classifyByRules(text, part).intent).toBe(expected);
  });

  it('only counts review verdict wording on a review part', () => {
    const text = 'Entry 3 is wrong and entry 5 looks fine overall';
    expect(classifyByRules(text, 'review_text').signals).toContain('answer:review-verdict');
    expect(classifyByRules(text, 'explain_text').signals).not.toContain('answer:review-verdict');
  });

  it('treats two numbered lines as a review verdict', () => {
    const text = '1. Rent entry posted to the right ledger\n2. Freight entry duplicated in March';
    expect(classifyByRules(text, 'review_text').signals).toContain('answer:review-verdict');
  });

  it('treats an empty message as a question rather than an answer', () => {
    expect(classifyByRules('   ', 'explain_text').intent).toBe('question');
  });

  it('records the deciding rule in the signals', () => {
    expect(classifyByRules('which ledger for bank charges', 'explain_text').signals).toContain('rule:question-signals');
  });
});
