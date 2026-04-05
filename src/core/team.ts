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
const ADMIN_ACTIONS = new Set(["admin", "manage_team", "add_member", "remove_member"]);

const now = (): string => new Date().toISOString();

const isReadAction = (action: string): boolean => {
  const normalized = action.trim().toLowerCase();

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

    if (normalizedName.length === 0) {
      throw new Error("Team name is required");
    }

    const team: Team = {
      id: randomUUID(),
      name: normalizedName,
      owner_id: ownerId,
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
      upsertMember.run(team.id, ownerId, "admin", team.created_at);
      this.repository.setMetadata(`${TEAM_METADATA_PREFIX}${team.id}`, JSON.stringify(team));
    })();

    return team;
  }

  addMember(teamId: string, userId: string, role: TeamRole): void {
    const joinedAt = now();

    this.repository.db
      .prepare<[string, string, TeamRole, string]>(
        `INSERT INTO team_members (team_id, user_id, role, joined_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(team_id, user_id)
         DO UPDATE SET role = excluded.role`
      )
      .run(teamId, userId, role, joinedAt);
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

    if (member.role === "member") {
      return !ADMIN_ACTIONS.has(action.trim().toLowerCase());
    }

    return isReadAction(action);
  }
}
