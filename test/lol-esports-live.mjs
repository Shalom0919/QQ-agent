// 显式联网测试，数据只写临时目录；不接触用户机器人配置或赛事归档。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EsportsClient, chinaDate } from "../skills/lol-esports/client.js";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qq-lol-live-"));
const c = new EsportsClient({ dir });
try {
  const leagues = await c.leagues();
  assert.ok(leagues.items.some((l) => l.slug === "worlds"));
  const today = Date.now();
  const schedule = await c.schedule({
    from: chinaDate(new Date(today - 14 * 86400000)),
    to: chinaDate(new Date(today + 7 * 86400000)),
  });
  assert.ok(!schedule.stale);
  console.log(
    `✓ 官网联赛 ${leagues.items.length}，窗口赛程 ${schedule.items.length}（截断=${schedule.truncated}）`,
  );
  if (schedule.items.length) {
    const match = await c.detail(schedule.items[0].id);
    assert.ok(match.item.teams.length);
    console.log("✓ 比赛详情与回放接口");
  }
  const teams = await c.request("GetTeams", { sport: ["lol"] });
  assert.ok(teams.data.teams.length);
  console.log("✓ 战队与选手接口");
  const ts = await c.request("GetOtherLeagues", {
    locale: "en-US",
    sport: "lol",
  });
  const t = ts.data.leagues.flatMap((l) => l.tournaments || [])[0];
  assert.ok(t);
  const standings = await c.request("GetSeasonTournamentDisplay", {
    tournamentId: [t.id],
  });
  assert.ok(standings.data.tournaments[0]?.stages);
  console.log("✓ 赛事届次与排名接口");
} finally {
  c.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
