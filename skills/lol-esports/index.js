import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../../src/config.js";
import {
  EsportsClient,
  SOURCE,
  bounded,
  chinaDate,
  publicEvent,
  selectEvents,
} from "./client.js";

let api;
let client;
let timer;
let active = false;
let generation = 0;
const dir = path.join(DATA_DIR, "lol-esports");
const string = (description) => ({ type: "string", description });
const filters = {
  league: string(
    "联赛名称或 ID，多项用逗号分隔，例如 LPL,LCK,Worlds；空值为全部",
  ),
  team: string("战队名称、英文简称或 ID"),
  from: string("北京时间开始日期 YYYY-MM-DD"),
  to: string("北京时间结束日期 YYYY-MM-DD"),
  state: {
    type: "string",
    enum: ["all", "unstarted", "inProgress", "completed"],
  },
  spoilerFree: { type: "boolean", description: "true 隐藏比分、胜者及局数" },
  limit: { type: "integer", minimum: 1, maximum: 50 },
  offset: { type: "integer", minimum: 0 },
};
function getClient() {
  if (!client || client.closed)
    client = new EsportsClient({
      dir,
      fetchImpl: api.fetch,
      config: api.config,
    });
  return client;
}
function meta(r) {
  return {
    source: SOURCE,
    fetchedAt: r.fetchedAt,
    stale: r.stale || false,
    warning: r.warning,
    truncated: r.truncated || false,
  };
}
function page(items, args) {
  const offset = bounded(args.offset, 0, 0, 30000),
    limit = bounded(args.limit, 15, 1, 50);
  return {
    total: items.length,
    offset,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    items: items.slice(offset, offset + limit),
  };
}
function tool(id, name, description, properties, required, execute) {
  api.registerTool({
    id,
    name,
    description,
    category: "query",
    parameters: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
    },
    async execute(ctx, args = {}) {
      try {
        return {
          content: JSON.stringify(await execute(getClient(), args, ctx)),
        };
      } catch (e) {
        return {
          content: JSON.stringify({
            error: e.message,
            source: SOURCE,
            hint: "不得编造赛果；可用 archive 查询已有本地记录，status 检查数据源状态。",
          }),
          isError: true,
        };
      }
    },
  });
}

export function setup(skillApi) {
  api = skillApi;
  tool(
    "leagues",
    "LOL 联赛列表",
    "查询官网当前 LOL 联赛名称和 ID。",
    {},
    [],
    async (c) => {
      const r = await c.leagues();
      return { ...meta(r), items: r.items };
    },
  );
  tool(
    "schedule",
    "LOL 赛程与赛果",
    "查询今日、指定日期范围的官方赛程/赛果，按战队或联赛筛选。日期按北京时间；默认今天。支持分页和防剧透。",
    filters,
    [],
    async (c, a) => {
      const r = await c.schedule(a);
      return {
        ...meta(r),
        from: r.from,
        to: r.to,
        timeZone: "Asia/Shanghai",
        ...page(
          r.items.map((e) => publicEvent(e, a.spoilerFree)),
          a,
        ),
      };
    },
  );
  tool(
    "match",
    "LOL 比赛详情与回放",
    "用赛程返回的赛事 id 获取 BO 赛制、比分、单局、直播源和回放。回放 provider/parameter 是官网原始标识，不要编造链接。",
    { id: string("赛程里的赛事 id"), spoilerFree: { type: "boolean" } },
    ["id"],
    async (c, a) => {
      const r = await c.detail(a.id);
      return { ...meta(r), item: publicEvent(r.item, a.spoilerFree, true) };
    },
  );
  tool(
    "teams",
    "LOL 战队与选手阵容",
    "查询官网列示的战队及选手阵容，支持英文简称、队名、选手名称搜索；可能包含历史选手，不能当作某场比赛首发。",
    {
      query: string("战队或选手名称，如 T1 或 Faker"),
      ...Object.fromEntries(["limit", "offset"].map((k) => [k, filters[k]])),
    },
    [],
    async (c, a) => {
      const r = await c.request("GetTeams", { sport: ["lol"] });
      if (!Array.isArray(r.data.teams)) throw new Error("官网战队格式已变化");
      const q = String(a.query || "").toLowerCase();
      const rows = r.data.teams.filter((t) =>
        JSON.stringify(t).toLowerCase().includes(q),
      );
      return {
        ...meta(r),
        note: "官网列示阵容，可能包含历史选手，不代表当场首发名单",
        ...page(rows, a),
      };
    },
  );
  tool(
    "tournaments",
    "LOL 赛事届次列表",
    "按联赛查询赛事届次 ID、开赛日期。先用此工具获取 tournamentId，再查排名。",
    {
      league: string("联赛名称/ID，例如 LCK 或 Worlds"),
      ...Object.fromEntries(["limit", "offset"].map((k) => [k, filters[k]])),
    },
    [],
    async (c, a) => {
      const ids = await c.leagueIds(a.league);
      const r = await c.request("GetOtherLeagues", {
        locale: "en-US",
        sport: "lol",
      });
      if (!Array.isArray(r.data.leagues)) throw new Error("官网赛事格式已变化");
      const rows = r.data.leagues
        .filter((l) => !ids || ids.includes(l.id))
        .flatMap((l) =>
          (l.tournaments || []).map((t) => ({
            id: t.id,
            name: t.name,
            startTime: t.startTime,
            endTime: t.endTime,
            league: l.name,
          })),
        )
        .sort((x, y) => Date.parse(y.startTime) - Date.parse(x.startTime));
      return { ...meta(r), ...page(rows, a) };
    },
  );
  tool(
    "standings",
    "LOL 赛事排名与赛段",
    "查询指定赛事届次的官方排名、阶段与分组；未公布排名时如实返回，不按胜场自行冒充官方排名。",
    { tournamentId: string("tournaments 或 schedule 返回的 tournamentId") },
    ["tournamentId"],
    async (c, a) => {
      if (!/^\d+$/.test(String(a.tournamentId)))
        throw new Error("tournamentId 必须来自官网查询结果");
      const r = await c.request("GetSeasonTournamentDisplay", {
        tournamentId: [a.tournamentId],
      });
      const ts = r.data.tournaments;
      if (!Array.isArray(ts) || !ts.length) throw new Error("未找到该届赛事");
      return {
        ...meta(r),
        items: ts.map((t) => ({
          id: t.id,
          name: t.name,
          state: t.state,
          standings: t.standings,
          stages: (t.stages || []).map((s) => ({
            id: s.id,
            name: s.name,
            sections: (s.sections || []).map((x) => ({
              name: x.name,
              type: x.type,
              standings: x.standings,
              rankings: x.rankings,
            })),
          })),
        })),
      };
    },
  );
  tool(
    "archive",
    "LOL 本地赛事记录",
    "查询已抓取的本地历史记录；不联网。离线、复盘、交手记录查询用。只有归档覆盖范围内的数据，不能声称全历史。",
    { ...filters, opponent: string("第二支战队，用于交手筛选") },
    [],
    async (c, a) => {
      let rows = selectEvents(Object.values(c.archive.events), a);
      if (a.league) {
        const q = a.league.toLowerCase();
        rows = rows.filter((e) =>
          [e.league?.id, e.league?.name, e.league?.slug].some(
            (v) => String(v).toLowerCase() === q,
          ),
        );
      }
      return {
        source: SOURCE,
        localArchive: true,
        lastSync: c.archive.lastSync,
        note: "仅包含已抓取且仍在保留期内的记录；每场 fetchedAt 表示最后核对时间",
        ...page(
          rows.map((e) => publicEvent(e, a.spoilerFree)),
          a,
        ),
      };
    },
  );
  tool(
    "head_to_head",
    "LOL 交手统计",
    "统计本地归档中两队已结束的系列赛胜负，区分系列赛胜负与小局胜负；不代表完整历史。可先查指定日期赛程补充记录。",
    {
      team: filters.team,
      opponent: string("对手战队英文简称、名称或 ID"),
      from: filters.from,
      to: filters.to,
    },
    ["team", "opponent"],
    async (c, a) => {
      if (!a.team?.trim() || !a.opponent?.trim())
        throw new Error("请填写两支战队");
      const rows = selectEvents(Object.values(c.archive.events), {
        ...a,
        state: "completed",
      });
      const teams = [
        ...new Map(rows.flatMap((e) => e.teams).map((t) => [t.id, t])).values(),
      ];
      const resolve = (query) => {
        const q = query.trim().toLowerCase();
        const values = (t) =>
          [t.id, t.name, t.code].map((v) => String(v || "").toLowerCase());
        const exact = teams.filter((t) => values(t).includes(q));
        const found = exact.length
          ? exact
          : teams.filter((t) => values(t).some((v) => v.includes(q)));
        if (found.length > 1)
          throw new Error(
            `战队名称 ${query} 不唯一，请指定战队 ID：${found.map((t) => `${t.name} (${t.id})`).join("、")}`,
          );
        return found[0]?.id;
      };
      const ownId = resolve(a.team),
        otherId = resolve(a.opponent);
      let wins = 0,
        losses = 0,
        unknown = 0,
        gamesWon = 0,
        gamesLost = 0;
      const eligible = [];
      for (const e of rows) {
        const own = e.teams.find((t) => t.id === ownId);
        const other = e.teams.find((t) => t !== own && t.id === otherId);
        if (!own || !other) continue;
        eligible.push(e);
        if (own.result?.outcome === "win") wins++;
        else if (own.result?.outcome === "loss") losses++;
        else unknown++;
        gamesWon += Number(own.result?.gameWins) || 0;
        gamesLost += Number(other.result?.gameWins) || 0;
      }
      return {
        source: SOURCE,
        scope: "仅本地已抓取记录，非完整历史",
        team: a.team,
        opponent: a.opponent,
        matches: eligible.length,
        wins,
        losses,
        unknown,
        gamesWon,
        gamesLost,
        from: eligible[0]?.startTime,
        to: eligible.at(-1)?.startTime,
        recent: eligible
          .slice(-10)
          .reverse()
          .map((e) => publicEvent(e)),
      };
    },
  );
  tool(
    "export",
    "LOL 赛事导出",
    "把本地归档按日期/战队筛选后导出 CSV、JSON 或 ICS 日历，文件保存到本地数据目录；不自动发送文件。ICS 默认仅未开赛对局，比赛时长为占位估计。",
    { ...filters, format: { type: "string", enum: ["csv", "json", "ics"] } },
    ["format"],
    async (c, a) => {
      if (!["csv", "json", "ics"].includes(a.format))
        throw new Error("不支持的导出格式");
      let rows = selectEvents(Object.values(c.archive.events), a);
      if (a.league)
        rows = rows.filter((e) =>
          [e.league?.name, e.league?.slug, e.league?.id].some(
            (v) => String(v).toLowerCase() === a.league.toLowerCase(),
          ),
        );
      if (a.format === "ics")
        rows = rows.filter((e) => e.state === "unstarted");
      if (!rows.length) throw new Error("没有匹配的归档，先查询赛程获取数据");
      const file = path.join(dir, "exports", `lol-${Date.now()}.${a.format}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = exportRecords(rows, a.format, a.spoilerFree);
      fs.writeFileSync(file, text, "utf8");
      return {
        file,
        count: rows.length,
        format: a.format,
        note:
          a.format === "ics"
            ? "北京时间显示；日历使用 UTC；预计时长 3 小时非官方结束时间；导入后不自动订阅更新"
            : "本地导出，不会自动发到群内",
      };
    },
  );
  tool(
    "status",
    "LOL 数据源状态",
    "查询自动更新状态、最近同步时间、本地记录数量、数据源错误。",
    {},
    [],
    async (c) => ({
      source: SOURCE,
      autoSync: active && c.settings().autoSync !== false,
      syncMinutes: bounded(c.settings().syncMinutes, 15, 5, 1440),
      lastSync: c.archive.lastSync,
      records: Object.keys(c.archive.events).length,
      lastError: c.lastError || null,
      note: "自动同步需机器人持续运行；官网网页接口并非稳定的公开开发者 API",
    }),
  );
  tool(
    "sync",
    "LOL 刷新赛事记录",
    "抓取管理员配置的联赛最近 7 天和未来 14 天，合并到本地归档。重复调用会合并，短期使用缓存。",
    {},
    [],
    async (c) => {
      const r = await c.sync();
      return {
        ...meta(r),
        fetched: r.items.length,
        records: Object.keys(c.archive.events).length,
        lastSync: c.archive.lastSync,
      };
    },
  );
}

export function exportRecords(rows, format, spoilerFree = false) {
  if (format === "json")
    return JSON.stringify(
      rows.map((e) => publicEvent(e, spoilerFree)),
      null,
      2,
    );
  const cell = (v) =>
    '"' +
    String(v ?? "")
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  if (format === "csv")
    return (
      "\uFEFF" +
      [
        [
          "赛事ID",
          "北京时间",
          "联赛",
          "战队1",
          "战队2",
          "比分",
          "状态",
          "抓取时间",
        ],
        ...rows.map((e) => {
          const p = publicEvent(e, spoilerFree);
          return [
            e.id,
            p.time,
            p.league,
            e.teams[0]?.name,
            e.teams[1]?.name,
            spoilerFree
              ? "隐藏"
              : e.teams.map((t) => t.result?.gameWins ?? "?").join(":"),
            e.state,
            e.fetchedAt,
          ];
        }),
      ]
        .map((r) => r.map(cell).join(","))
        .join("\r\n")
    );
  const escape = (s) =>
    String(s || "")
      .replaceAll("\\", "\\\\")
      .replaceAll("\n", "\\n")
      .replaceAll(";", "\\;")
      .replaceAll(",", "\\,");
  const stamp = (s) =>
    new Date(s)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//QQ Agent//LOL Esports//ZH",
    "CALSCALE:GREGORIAN",
    ...rows.flatMap((e) => [
      "BEGIN:VEVENT",
      `UID:lol-${e.id}@qq-agent`,
      `DTSTAMP:${stamp(e.fetchedAt)}`,
      `DTSTART:${stamp(e.startTime)}`,
      `DTEND:${stamp(Date.parse(e.startTime) + 3 * 3600000)}`,
      `SUMMARY:${escape(e.teams.map((t) => t.code || t.name).join(" vs "))}`,
      `DESCRIPTION:${escape((e.league?.name || "") + "；预计时长3小时，实际以官方为准；" + SOURCE)}`,
      "END:VEVENT",
    ]),
    "END:VCALENDAR",
  ];
  // RFC 5545: 按 UTF-8 字节折行，避免中文被切坏。
  return (
    lines
      .map((line) => {
        let out = "",
          n = 0;
        for (const ch of line) {
          const size = Buffer.byteLength(ch);
          if (n + size > 75) {
            out += "\r\n ";
            n = 1;
          }
          out += ch;
          n += size;
        }
        return out;
      })
      .join("\r\n") + "\r\n"
  );
}
export function activate() {
  if (active) return;
  active = true;
  const epoch = ++generation;
  const tick = async () => {
    if (!active || generation !== epoch) return;
    try {
      const c = getClient();
      if (c.settings().autoSync !== false) await c.sync();
    } catch (e) {
      if (client) client.lastError = e.message;
      api.warn?.("赛事自动同步失败：" + e.message);
    } finally {
      if (active && generation === epoch) {
        timer = setTimeout(
          tick,
          bounded(api.config().syncMinutes, 15, 5, 1440) * 60000,
        );
        timer.unref?.();
      }
    }
  };
  timer = setTimeout(tick, 3000);
  timer.unref?.();
}
export function deactivate() {
  active = false;
  generation++;
  clearTimeout(timer);
  client?.close();
}
export function dispose() {
  deactivate();
}
export function available() {
  return true;
}
