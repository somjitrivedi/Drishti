import type { IncomingMessage, ServerResponse } from "node:http";
import type { Scope } from "../meta/apiKeys.js";
import type { Principal } from "../auth/authenticator.js";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  principal: Principal | null;
  route: string;
  bodyAborted: boolean;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

export interface Route {
  method: string;
  pattern: string;
  parts: string[];
  scope: Scope | "any" | null;
  handler: Handler;
}

export type MatchResult = { route: Route; params: Record<string, string> } | { allowed: string[] } | null;

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, scope: Route["scope"], handler: Handler): this {
    this.routes.push({ method, pattern, parts: pattern.split("/").filter(Boolean), scope, handler });
    return this;
  }

  match(method: string, pathname: string): MatchResult {
    const parts = pathname.split("/").filter(Boolean);
    const allowed: string[] = [];
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const p = route.parts[i]!;
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i]!);
        else if (p !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method === method || (method === "HEAD" && route.method === "GET")) return { route, params };
      allowed.push(route.method);
    }
    return allowed.length ? { allowed } : null;
  }
}
