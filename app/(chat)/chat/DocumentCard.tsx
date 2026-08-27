type DocumentCardProps = {
  documentName: string;
  url: string;
};

// File-attachment card, not an inline PDF preview — per ui-context.md's
// chat-appropriate conventions, a real chat product shows attachments as
// cards. bg-surface + radius-md per Unit 10's design note.
export function DocumentCard({ documentName, url }: DocumentCardProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md border border-border-default bg-bg-surface px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-bg-surface-raised"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        className="h-5 w-5 shrink-0 text-text-secondary"
      >
        <path
          d="M6 2h8l4 4v16H6V2z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d="M14 2v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <span className="flex-1 truncate font-medium">{documentName}</span>
      <span className="shrink-0 text-xs text-accent">View</span>
    </a>
  );
}
