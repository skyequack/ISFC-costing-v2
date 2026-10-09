export {};

declare global {
  // Custom session token: {"role":"{{user.public_metadata.role}}"} (docs/RUNBOOK.md)
  interface CustomJwtSessionClaims {
    role?: string;
  }
}
