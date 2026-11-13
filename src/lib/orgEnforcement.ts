export type OrgBlockCode = 'SUSPENDED' | 'DELETED' | 'NOT_VERIFIED';

export function parseOrgEnforcementError(err: unknown): OrgBlockCode | null {
  if (!err) return null;
  const raw =
    typeof err === 'string'
      ? err
      : [
          (err as any)?.message,
          (err as any)?.details,
          (err as any)?.hint,
        ]
          .filter(Boolean)
          .join(' ');

  const match = raw.match(/ORG_NOT_ALLOWED:\s*(SUSPENDED|DELETED|NOT_VERIFIED)/i);
  if (!match) return null;
  return match[1].toUpperCase() as OrgBlockCode;
}

export function getOrgEnforcementMessage(code: OrgBlockCode): string {
  switch (code) {
    case 'NOT_VERIFIED':
      return 'Account verification required before starting live events — your events & roster remain editable.';
    case 'SUSPENDED':
      return 'This organization has been suspended by an administrator.';
    case 'DELETED':
      return 'This organization has been removed.';
  }
}
