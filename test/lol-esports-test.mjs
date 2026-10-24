import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EsportsClient,
  dateRange,
  chinaDate,
  normalizeEvent,
  publicEvent,
} from "../skills/lol-esports/client.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-lol-test-"));
process.env.QQ_AGENT_DATA_DIR = root;
const mod = await import("../skills/lol-esports/index.js");
const event = (id = "1", state = "completed") => ({
  id,
  type: "match",
  startTime: "2026-10-21T16:30:00Z",
  state,
  blockName: "决赛",
  league: { id: "10", name: "LCK", slug: "lck" },
  tournament: { id: "20", name: "2026" },
  matchTeams: [
    {
      teamId: "100",
      code: "T1",
      name: "T1",
      result: { gameWins: 3, outcome: "win" },
    },
    {
      teamId: "200",
      code: "GEN",
      name: "Gen.G",
      result: { gameWins: 1, outcome: "loss" },
    },
  ],
  match: {
    strategy: { count: 5 },
    games: [
      {
        id: "3",
        number: 1,
        state: "completed",
        vods: [
          {
            provider: "youtube",
            parameter: "test-video",
            startMillis: 120000,
            mediaLocale: { locale: "zh-TW" },
          },
        ],
      },
    ],
  },
});
const json = (data) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ data }),
});
let calls = 0,
  fail = false,
  clock = Date.parse("2026-10-22T00:00:00Z");
const fetchMock = async (url) => {
  calls++;
  if (fail) throw new Error("网络断开");
  const op = url.searchParams.get("operationName");
  const vars = JSON.parse(url.searchParams.get("variables"));
  assert.equal(url.origin, "https://lolesports.com");
  assert.ok(
    JSON.parse(url.searchParams.get("extensions")).persistedQuery.sha256Hash,
  );
  if (op === "homeLeagues")
    return json({ leagues: [{ id: "10", name: "LCK", slug: "lck" }] });
  if (op === "homeEvents") {
    assert.equal(vars.eventDateStart, "2026-10-22T00:00:00+08:00");
    return json({
      esports: {
        events: [event(vars.pageToken ? "2" : "1")],
        pages: { newer: vars.pageToken ? null : "next" },
      },
    });
  }
  if (op === "watchVodQuery") {
    const e = event();
    delete e.state;
    e.tournament = { id: "20" };
    e.match.matchTeams = e.matchTeams;
    delete e.matchTeams;
    return json({ scheduledEvent: e });
  }
  if (op === "GetTeams")
    return json({
      teams: [
        { id: "100", name: "T1", code: "T1", players: [{ handle: "Faker" }] },
      ],
    });
  if (op === "GetOtherLeagues")
    return json({
      leagues: [
        {
          id: "10",
          name: "LCK",
          tournaments: [
            { id: "20", name: "2026", startTime: "2026-01-01T00:00:00Z" },
          ],
        },
      ],
    });
  if (op === "GetSeasonTournamentDisplay")
    return json({
      tournaments: [
        {
          id: "20",
          stages: [
            {
              name: "决赛",
              sections: [
                {
                  name: "决赛",
                  standings: [{ placement: 1, team: { name: "T1" } }],
                },
              ],
            },
          ],
        },
      ],
    });
  throw new Error("unexpected " + op);
};
try {
  const c = new EsportsClient({
    dir: path.join(root, "unit"),
    fetchImpl: fetchMock,
    now: () => clock,
    config: () => ({ cacheMinutes: 1 }),
  });
  assert.equal(chinaDate(new Date("2026-10-21T16:30:00Z")), "2026-10-22");
  assert.throws(() => dateRange("2026-02-30", "2026-03-01"));
  assert.throws(() => dateRange("2026-10-23", "2026-10-22"));
  const query = { from: "2026-10-22", to: "2026-10-22", league: "LCK" };
  const r = await c.schedule(query);
  assert.equal(r.items.length, 2);
  assert.equal(r.truncated, false);
  assert.equal(Object.keys(c.archive.events).length, 2);
  const count = calls;
  await Promise.all([c.schedule(query), c.schedule(query)]);
  assert.equal(calls, count, "新鲜缓存不请求");
  const detail = await c.detail("1");
  assert.equal(detail.item.tournament.name, "2026", "详情不能擦掉已有届次信息");
  assert.equal(detail.item.state, "completed");
  assert.match(
    publicEvent(detail.item, false, true).games[0].vods[0].url,
    /t=120s/,
  );
  const hidden = JSON.stringify(publicEvent(r.items[0], true, true));
  assert.ok(
    !hidden.includes("gameWins") &&
      !hidden.includes("outcome") &&
      !hidden.includes("vods"),
  );
  const persisted = new EsportsClient({ dir: c.dir });
  assert.equal(Object.keys(persisted.archive.events).length, 2);
  persisted.close();
  clock += 120000;
  fail = true;
  const stale = await c.schedule(query);
  assert.equal(stale.stale, true);
  assert.match(stale.warning, /网络断开/);
  await assert.rejects(
    () => c.request("GetTeams", { sport: ["lol"] }),
    /网络断开/,
  );
  fail = false;
  const partial = new EsportsClient({
    dir: path.join(root, "partial"),
    fetchImpl: fetchMock,
    now: () => clock,
    config: () => ({ maxPages: 1 }),
  });
  assert.equal((await partial.schedule(query)).truncated, true);
  partial.close();
  let concurrentCalls = 0;
  const concurrency = new EsportsClient({
    dir: path.join(root, "concurrent"),
    fetchImpl: async () => {
      concurrentCalls++;
      await new Promise((r) => setTimeout(r, 10));
      return json({ leagues: [] });
    },
  });
  await Promise.all([concurrency.leagues(), concurrency.leagues()]);
  assert.equal(concurrentCalls, 1);
  concurrency.close();
  c.close();
  await assert.rejects(() => c.leagues(), /停用/);
  const tools = new Map();
  mod.setup({
    config: () => ({ autoSync: false }),
    fetch: fetchMock,
    registerTool: (t) => tools.set(t.id, t),
    warn: () => {},
  });
  assert.equal(tools.size, 11);
  const run = async (id, args = {}) => {
    const result = await tools.get(id).execute({}, args);
    assert.ok(!result.isError, result.content);
    return JSON.parse(result.content);
  };
  assert.equal((await run("schedule", query)).items.length, 2);
  assert.equal((await run("teams", { query: "Faker" })).total, 1);
  assert.equal((await run("tournaments", { league: "LCK" })).items[0].id, "20");
  assert.equal(
    (await run("standings", { tournamentId: "20" })).items[0].stages[0]
      .sections[0].standings[0].placement,
    1,
  );
  const h = await run("head_to_head", { team: "T1", opponent: "GEN" });
  assert.equal(h.matches, 2);
  assert.equal(h.wins, 2);
  assert.equal(h.gamesWon, 6);
  assert.equal(
    (await run("head_to_head", { team: "T1", opponent: "T1" })).matches,
    0,
  );
  assert.equal((await run("archive", { spoilerFree: true })).total, 2);
  const exported = await run("export", { format: "json", spoilerFree: true });
  assert.ok(fs.existsSync(exported.file));
  assert.ok(!fs.readFileSync(exported.file, "utf8").includes("gameWins"));
  const n = normalizeEvent(event(), new Date(clock).toISOString());
  n.teams[0].name = '=HYPERLINK("bad")';
  assert.match(mod.exportRecords([n], "csv"), /'=HYPERLINK/);
  n.teams[0].code = "测".repeat(100);
  const ics = mod.exportRecords([n], "ics");
  assert.match(ics, /DTSTART:20261021T163000Z/);
  assert.match(ics, /UID:lol-1@qq-agent/);
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));
  mod.activate();
  mod.deactivate();
  assert.equal((await run("status")).autoSync, false);
  mod.dispose();
  // 使用真实加载器：校验 manifest、权限与工具名前缀，不启动后台联网。
  const { loadPlugins, unloadSkill } = await import("../src/plugin-loader.js");
  const bundle = path.join(root, "skills");
  fs.mkdirSync(bundle);
  // 临时入口转发到原模块，使相对核心依赖仍按实际安装目录解析。
  const target = path.join(bundle, "lol-esports");
  fs.mkdirSync(target);
  fs.copyFileSync(
    new URL("../skills/lol-esports/skill.json", import.meta.url),
    path.join(target, "skill.json"),
  );
  fs.writeFileSync(
    path.join(target, "index.js"),
    `export * from ${JSON.stringify(new URL("../skills/lol-esports/index.js", import.meta.url).href)};`,
  );
  fs.writeFileSync(path.join(root, "package.json"), ' {"type":"module"}');
  const loaded = await loadPlugins({
    roots: { skills: bundle, plugins: path.join(root, "no-plugins") },
    log: () => {},
  });
  assert.equal(loaded.failed.length, 0);
  assert.equal(loaded.loaded[0].skill.toolIds.length, 11);
  assert.ok(loaded.loaded[0].skill.toolIds.includes("lol-esports__schedule"));
  unloadSkill("lol-esports");
  console.log(
    "✓ LOL赛事：官网适配、分页、时区、缓存/离线、持久化、防剧透、统计、导出、生命周期及真实加载全部通过",
  );
} finally {
  mod.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}
