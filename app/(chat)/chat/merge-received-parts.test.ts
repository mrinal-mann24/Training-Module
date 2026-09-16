import { describe, expect, it } from 'vitest';
import { mergeReceivedParts } from './merge-received-parts';

describe('mergeReceivedParts', () => {
  it('adds parts not yet seen', () => {
    expect(mergeReceivedParts(['daybook_xml'], ['trialbalance_xml'])).toEqual(['daybook_xml', 'trialbalance_xml']);
  });

  // The database read and a Realtime INSERT can both report the same part,
  // because the read happens after the channel is already live.
  it('does not duplicate a part reported by both sources', () => {
    expect(mergeReceivedParts(['daybook_xml'], ['daybook_xml', 'trialbalance_xml'])).toEqual([
      'daybook_xml',
      'trialbalance_xml',
    ]);
  });

  it('dedupes within the incoming list itself', () => {
    expect(mergeReceivedParts([], ['explain_text', 'explain_text'])).toEqual(['explain_text']);
  });

  // The live bug: the checklist started empty and only learned from events,
  // so file parts written before it subscribed never showed. A read that
  // arrives later must fill them in, not be dropped.
  it('fills an empty checklist from a later database read', () => {
    expect(mergeReceivedParts([], ['daybook_xml', 'trialbalance_xml'])).toEqual(['daybook_xml', 'trialbalance_xml']);
  });

  it('never removes a part it already had, whatever the incoming list says', () => {
    expect(mergeReceivedParts(['explain_text'], [])).toEqual(['explain_text']);
  });

  it('keeps existing order and appends new parts', () => {
    expect(mergeReceivedParts(['explain_text', 'daybook_xml'], ['trialbalance_xml', 'daybook_xml'])).toEqual([
      'explain_text',
      'daybook_xml',
      'trialbalance_xml',
    ]);
  });
});
