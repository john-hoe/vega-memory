import { randomUUID } from "node:crypto";

import type { Memory } from "./types.js";
import { Repository } from "../db/repository.js";

export type TeamRole = "admin" | "member" | "readonly";

export interface Team {
  id: string;
  name: string;
  owner_id: string;
  created_at: string;
}

export interface TeamMember {
  user_id: string;
  team_id: string;
  role: TeamRole;
  joined_at: string;
}

interface TeamRow extends Team {}

interface TeamMemberRow extends TeamMember {}

const TEAM_METADATA_PREFIX = "team.";
const ADMIN_ACTIONS = new Set([
  "admin",
  "manage_team",
  "add_member",
  "remove_member",
  "delete_team",
  "update_team",
  "set_role",
  "grant_admin",
  "revoke_admin",
  "transfer_ownership"
]);
const MEMBER_WRITE_ACTIONS = new Set([
  "write",
  "store",
  "create",
  "update",
  "delete",
  "edit",
  "archive",
  "compact"
]);

const now = (): string => new Date().toISOString();

const normalizeAction = (action: string): string => action.trim().toLowerCase();

const isReadAction = (action: string): boolean => {
  const normalized = normalizeAction(action);

  return (
    normalized === "read" ||
    normalized === "view" ||
    normalized === "list" ||
    normalized === "recall" ||
    normalized === "search" ||
    normalized.startsWith("read_") ||
    normalized.startsWith("view_") ||
    normalized.startsWith("list_") ||
    normalized.startsWith("recall_") ||
    normalized.startsWith("search_")
  );
};

const isWriteAction = (action: string): boolean => {
  const normalized = normalizeAction(action);

  return (
    MEMBER_WRITE_ACTIONS.has(normalized) ||
    normalized.startsWith("write_") ||
    normalized.startsWith("store_") ||
    normalized.startsWith("create_") ||
    normalized.startsWith("update_") ||
    normalized.startsWith("delete_") ||
    normalized.startsWith("edit_") ||
    normalized.startsWith("archive_")
  );
};

export class TeamService {
  constructor(private readonly repository: Repository) {}

  private getTeam(teamId: string): Team | null {
    const row = this.repository.db
      .prepare<[string], TeamRow>("SELECT id, name, owner_id, created_at FROM teams WHERE id = ?")
      .get(teamId);

    return row ?? null;
  }

  createTeam(name: string, ownerId: string): Team {
    const normalizedName = name.trim();
    const normalizedOwnerId = ownerId.trim();

    if (normalizedName.length === 0) {
      throw new Error("Team name is required");
    }

    if (normalizedOwnerId.length === 0) {
      throw new Error("Owner ID is required");
    }

    const team: Team = {
      id: randomUUID(),
      name: normalizedName,
      owner_id: normalizedOwnerId,
      created_at: now()
    };

    const insertTeam = this.repository.db.prepare<[string, string, string, string]>(
      "INSERT INTO teams (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)"
    );
    const upsertMember = this.repository.db.prepare<[string, string, TeamRole, string]>(
      `INSERT INTO team_members (team_id, user_id, role, joined_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(team_id, user_id)
       DO UPDATE SET role = excluded.role`
    );

    this.repository.db.transaction(() => {
      insertTeam.run(team.id, team.name, team.owner_id, team.created_at);
      upsertMember.run(team.id, normalizedOwnerId, "admin", team.created_at);
      this.repository.setMetadata(`${TEAM_METADATA_PREFIX}${team.id}`, JSON.stringify(team));
    })();

    return team;
  }

  addMember(teamId: string, userId: string, role: TeamRole): void {
    if (this.getTeam(teamId) === null) {
      throw new Error(`Team not found: ${teamId}`);
    }

    const normalizedUserId = userId.trim();

    if (normalizedUserId.length === 0) {
      throw new Error("User ID is required");
    }

    const joinedAt = now();

    this.repository.db
      .prepare<[string, string, TeamRole, string]>(
        `INSERT INTO team_members (team_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(team_id, user_id)
         DO UPDATE SET role = excluded.role`
      )
      .run(teamId, normalizedUserId, role, joinedAt);
  }

  listMembers(teamId: string): TeamMember[] {
    return this.repository.db
      .prepare<[string], TeamMemberRow>(
        `SELECT user_id, team_id, role, joined_at
         FROM team_members
         WHERE team_id = ?
         ORDER BY joined_at ASC, user_id ASC`
      )
      .all(teamId);
  }

  getTeamMemories(teamId: string): Memory[] {
    const team = this.getTeam(teamId);

    if (!team) {
      return [];
    }

    return this.repository.listMemories({
      project: team.name,
      limit: 10_000,
      sort: "updated_at DESC"
    });
  }

  checkPermission(userId: string, teamId: string, action: string): boolean {
    const team = this.getTeam(teamId);

    if (!team) {
      return false;
    }

    if (team.owner_id === userId) {
      return true;
    }

    const member = this.repository.db
      .prepare<[string, string], { role: TeamRole }>(
        "SELECT role FROM team_members WHERE team_id = ? AND user_id = ?"
      )
      .get(teamId, userId);

    if (!member) {
      return false;
    }

    if (member.role === "admin") {
      return true;
    }

    const normalizedAction = normalizeAction(action);

    if (ADMIN_ACTIONS.has(normalizedAction)) {
      return false;
    }

    if (member.role === "member") {
      return isReadAction(normalizedAction) || isWriteAction(normalizedAction);
    }

    return isReadAction(normalizedAction);
  }
}
