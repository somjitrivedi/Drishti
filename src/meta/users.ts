import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { MetaDb } from "./db.js";

export type Role = "owner" | "admin" | "member" | "viewer";
export const roles: Role[] = ["owner", "admin", "member", "viewer"];

export interface User {
  id: number;
  orgId: number;
  email: string;
  name: string;
  role: Role;
  createdAt: number;
}

export class UserError extends Error {}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCRYPT_N = 16384;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: SCRYPT_N, r: 8, p: 1 });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [scheme, n, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !n || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: Number(n), r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

interface UserRow {
  id: number;
  org_id: number;
  email: string;
  name: string;
  role: Role;
  password_hash: string;
  created_at: number;
}

const toUser = (r: UserRow): User => ({ id: r.id, orgId: r.org_id, email: r.email, name: r.name, role: r.role, createdAt: r.created_at });

export function createUser(db: MetaDb, input: { orgId: number; email: string; name: string; password: string; role: Role }): User {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL.test(email)) throw new UserError("invalid email");
  if (!input.name.trim()) throw new UserError("name is required");
  if (input.password.length < 10) throw new UserError("password must be at least 10 characters");
  if (!roles.includes(input.role)) throw new UserError(`role must be one of ${roles.join(", ")}`);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new UserError("email already registered");
  const now = Date.now();
  const id = Number(
    db
      .prepare("INSERT INTO users (org_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(input.orgId, email, input.name.trim(), hashPassword(input.password), input.role, now).lastInsertRowid
  );
  return { id, orgId: input.orgId, email, name: input.name.trim(), role: input.role, createdAt: now };
}

export function verifyUser(db: MetaDb, email: string, password: string): User | undefined {
  const row = db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) as UserRow | undefined;
  if (!row || !checkPassword(password, row.password_hash)) return undefined;
  return toUser(row);
}

export function listUsers(db: MetaDb, orgId: number): User[] {
  return (db.prepare("SELECT * FROM users WHERE org_id = ? ORDER BY id").all(orgId) as UserRow[]).map(toUser);
}
