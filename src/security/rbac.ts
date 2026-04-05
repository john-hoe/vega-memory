import { Repository } from "../db/repository.js";

export type RBACRole = "admin" | "member" | "readonly";

interface TeamMemberRoleRow {
  role: RBACRole;
}

const PERMISSIONS: Record<RBACRole, Set<string>> = {
  admin: new Set(["store", "recall", "list", "update", "delete", "compact", "session", "admin"]),
  member: new Set(["store", "recall", "list", "update", "session"]),
  readonly: new Set(["recall", "list"])
};

const normalizeAction = (action: string): string => action.trim().toLowerCase();

const canonicalizeAction = (action: string): string => {
  const normalized = normalizeAction(action);

  for (const candidate of ["store", "recall", "list", "update", "delete", "compact", "session", "admin"]) {
    if (normalized === candidate || normalized.startsWith(`${candidate}_`)) {
      return candidate;
    }
  }

  return normalized;
};

export class RBACService {
  constructor(private readonly repository: Repository) {}

  checkPermission(userId: string, teamId: string, action: string): boolean {
    const member = this.repository.db
      .prepare<[string, string], TeamMemberRoleRow>(
        `SELECT role
         FROM team_members
         WHERE team_id = ? AND user_id = ?`
      )
      .get(teamId, userId);

    if (!member) {
      return false;
    }

    return PERMISSIONS[member.role].has(canonicalizeAction(action));
  }

  requirePermission(userId: string, teamId: string, action: string): void {
    if (!this.checkPermission(userId, teamId, action)) {
      throw new Error(`Permission denied: ${userId} cannot ${action} on team ${teamId}`);
    }
  }
}
