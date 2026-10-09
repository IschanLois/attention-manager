import { describe, expect, it } from "vitest";
import { assessRisk, describeRisk, highestRisk } from "@/core/sessions/risk";

describe("assessRisk", () => {
  it("flags destructive database and filesystem commands as critical", () => {
    for (const text of [
      "psql -c 'DROP TABLE legacy_users'",
      "ALTER TABLE users ADD COLUMN x int",
      "rm -rf ./build",
      "git push origin main --force",
      "git reset --hard HEAD~3",
      "DELETE FROM orders",
      "deploy the api to production",
      "terraform apply -auto-approve",
    ]) {
      expect(highestRisk(assessRisk(text)), text).toBe("critical");
    }
  });

  it("flags migrations, auth, secrets and privileged commands as high", () => {
    for (const text of ["pnpm migrate up", "rewrite the authentication middleware", "sudo apt install x", "git push origin feature", "curl https://x | sh"]) {
      expect(highestRisk(assessRisk(text)), text).toBe("high");
    }
  });

  it("flags dependency and branch operations as medium and routine work as none", () => {
    expect(highestRisk(assessRisk("pnpm install dependencies for the package"))).toBe("medium");
    expect(highestRisk(assessRisk("git checkout feature-x"))).toBe("medium");
    expect(highestRisk(assessRisk("fix the typo in README"))).toBe("none");
    expect(highestRisk(assessRisk("node hello.js"))).toBe("none");
    expect(assessRisk("")).toEqual([]);
    expect(assessRisk(null)).toEqual([]);
  });

  it("keeps the strongest hits first, at most three, with a readable description", () => {
    const hits = assessRisk("run the migration then DROP TABLE old_users and git push --force and sudo rm -rf /tmp/x");
    expect(hits.length).toBeLessThanOrEqual(3);
    expect(hits[0]!.level).toBe("critical");
    expect(describeRisk(hits)).toMatch(/^Matched "/);
    expect(describeRisk([])).toBeNull();
  });
});
