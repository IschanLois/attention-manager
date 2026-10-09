import { PRIORITY_RANK, type Priority, type RiskHit } from "../schemas.ts";

interface RiskRule {
  level: Priority;
  pattern: RegExp;
}

// Deterministic keyword rules for how consequential an agent's action or task is.
// Order matters only for the reason text; the highest level wins.
const RISK_RULES: RiskRule[] = [
  { level: "critical", pattern: /\b(drop|truncate)\s+(table|database|schema|index|view)\b/i },
  { level: "critical", pattern: /\balter\s+(table|database|schema)\b/i },
  { level: "critical", pattern: /\b(drop|truncate|delete|wipe|destroy|purge)\b[^\n]{0,40}\b(tables?|databases?|schemas?|collections?|buckets?)\b/i },
  { level: "critical", pattern: /\brm\s+(-[a-z]*r[a-z]*\s+|-[a-z]*f[a-z]*r[a-z]*\s+)/i },
  { level: "critical", pattern: /\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/i },
  { level: "critical", pattern: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)\b/i },
  { level: "critical", pattern: /\b(terraform\s+(apply|destroy)|kubectl\s+(delete|apply)|helm\s+(uninstall|upgrade))\b/i },
  { level: "critical", pattern: /\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)\b/i },
  { level: "critical", pattern: /\b(prod|production)\b[^\n]{0,80}\b(deploy|migrat|delete|drop|rollback|wipe)/i },
  { level: "critical", pattern: /\b(deploy|migrat|delete|drop|rollback|wipe)[^\n]{0,80}\b(prod|production)\b/i },
  { level: "critical", pattern: /\bdelete\s+from\b/i },
  { level: "high", pattern: /\b(ddl|migrations?|migrate)\b/i },
  { level: "high", pattern: /\b(create|drop)\s+(user|role)\b/i },
  { level: "high", pattern: /\bgit\s+(push|rebase|merge)\b/i },
  { level: "high", pattern: /\b(payment|billing|invoice|auth(entication|orization)?|password|secret|credential|api[_ -]?key|token)s?\b/i },
  { level: "high", pattern: /\b(chmod|chown)\s+-R\b/i },
  { level: "high", pattern: /\bcurl\b[^\n]*\|\s*(ba|z)?sh\b/i },
  { level: "high", pattern: /\bsudo\b/i },
  { level: "high", pattern: /\b(npm|pnpm|yarn)\s+publish\b/i },
  { level: "high", pattern: /\.env\b/i },
  { level: "medium", pattern: /\b(install|upgrade|update|remove)\b[^\n]{0,40}\b(dependenc|package)/i },
  { level: "medium", pattern: /\bgit\s+(checkout|switch|stash|revert)\b/i },
  { level: "medium", pattern: /\b(refactor|rewrite|rename)\b[^\n]{0,60}\b(all|every|across|whole)\b/i },
  { level: "medium", pattern: /\b(schema|database|db)\b/i },
];

export function assessRisk(text: string | null | undefined): RiskHit[] {
  if (!text) return [];
  const hits: RiskHit[] = [];
  for (const rule of RISK_RULES) {
    const match = rule.pattern.exec(text);
    if (match) hits.push({ level: rule.level, match: match[0].replace(/\s+/g, " ").trim().slice(0, 60) });
  }
  return hits.sort((a, b) => PRIORITY_RANK[a.level] - PRIORITY_RANK[b.level]).slice(0, 3);
}

export function highestRisk(hits: RiskHit[]): Priority {
  return hits.reduce<Priority>((best, hit) => (PRIORITY_RANK[hit.level] < PRIORITY_RANK[best] ? hit.level : best), "none");
}

export function describeRisk(hits: RiskHit[]): string | null {
  if (hits.length === 0) return null;
  return `Matched ${hits.map((h) => `"${h.match}"`).join(", ")}`;
}
