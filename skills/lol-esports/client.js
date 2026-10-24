import fs from "node:fs";
import path from "node:path";

export const SOURCE = "https://lolesports.com";
const operations = JSON.parse(
  fs.readFileSync(new URL("./operations.json", import.meta.url), "utf8"),
);
export const DEFAULTS = {
  autoSync: true,
  syncMinutes: 15,
  cacheMinutes: 5,
  leagues: "LPL,LCK,LEC,LCS,MSI,Worlds,First Stand",
  maxPages: 5,
  retentionDays: 730,
};
export const bounded = (v, fallback, min, max) =>
  Number.isFinite(Number(v))
    ? Math.max(min, Math.min(max, Math.floor(Number(v))))
    : fallback;
export const chinaDate = (date = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
export const chinaTime = (value) =>
  value
    ? new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        dateStyle: "short",
        timeStyle: "short",
        hour12: false,
      }).format(new Date(value))
    : "待定";
export function dateRange(from, to) {
  const valid = (s) =>
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s;
  if (!valid(from) || !valid(to) || from > to)
    throw new Error("日期须为有效 YYYY-MM-DD，且开始日期不晚于结束日期");
  return {
    eventDateStart: `${from}T00:00:00+08:00`,
    eventDateEnd: `${to}T23:59:59.999+08:00`,
  };
}
export function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "__typename")
        .map(([k, v]) => [k, clean(v)]),
    );
  return value;
}
export function normalizeEvent(event, fetchedAt) {
  return {
    id: event.id,
    startTime: event.startTime,
    state: event.state,
    blockName: event.blockName,
    league: event.league,
    tournament: event.tournament,
    teams: (event.matchTeams || event.match?.matchTeams || []).map((t) => ({
      id: t.teamId || t.id,
      name: t.name,
      code: t.code,
      result: t.result,
    })),
    bestOf: event.match?.strategy?.count,
    games: (event.match?.games || []).map((g) => ({
      id: g.id,
      number: g.number,
      state: g.state,
      vods: (g.vods || []).map((v) => ({
        provider: v.provider,
        parameter: v.parameter,
        locale: v.mediaLocale?.locale,
        startMillis: v.startMillis,
        url:
          v.provider === "youtube"
            ? `https://www.youtube.com/watch?v=${encodeURIComponent(v.parameter)}&t=${Math.floor((v.startMillis || 0) / 1000)}s`
            : v.provider === "twitch"
              ? `https://www.twitch.tv/videos/${encodeURIComponent(v.parameter)}`
              : undefined,
      })),
    })),
    streams: event.streams || [],
    fetchedAt,
    source: SOURCE,
    url: `${SOURCE}/en-US`,
  };
}
export function selectEvents(
  events,
  { team = "", opponent = "", from, to, state = "all" } = {},
) {
  const matches = (e, q) =>
    !q ||
    e.teams.some((t) =>
      [t.id, t.name, t.code].some((v) =>
        String(v || "")
          .toLowerCase()
          .includes(q.toLowerCase()),
      ),
    );
  return events
    .filter(
      (e) =>
        matches(e, team) &&
        matches(e, opponent) &&
        (!from || chinaDate(new Date(e.startTime)) >= from) &&
        (!to || chinaDate(new Date(e.startTime)) <= to) &&
        (state === "all" || e.state === state),
    )
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}
export function publicEvent(e, spoiler = false, detail = false) {
  const result = {
    id: e.id,
    time: chinaTime(e.startTime),
    timeZone: "Asia/Shanghai",
    league: e.league?.name,
    tournament: e.tournament?.name,
    tournamentId: e.tournament?.id,
    stage: e.blockName,
    bestOf: e.bestOf,
    state: e.state,
    teams: e.teams.map((t) => ({
      id: t.id,
      name: t.name,
      code: t.code,
      ...(spoiler ? {} : { result: t.result }),
    })),
    fetchedAt: e.fetchedAt,
  };
  if (detail) {
    // 防剧透模式不暴露已进行局数、单局状态或回放数量。
    const preferred = (v) =>
      v.locale?.startsWith("zh") ? 0 : v.locale?.startsWith("en") ? 1 : 2;
    result.games = spoiler
      ? undefined
      : e.games.map((g) => ({
          ...g,
          vods: [...(g.vods || [])]
            .sort((a, b) => preferred(a) - preferred(b))
            .slice(0, 4),
        }));
    result.streams = e.streams;
  }
  return result;
}
export class EsportsClient {
  constructor({
    dir,
    fetchImpl = globalThis.fetch,
    config = () => ({}),
    now = () => Date.now(),
  }) {
    this.dir = dir;
    this.fetch = fetchImpl;
    this.config = config;
    this.now = now;
    this.inflight = new Map();
    this.cache = new Map();
    this.file = path.join(dir, "archive.json");
    this.archive = { version: 1, events: {}, lastSync: null };
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !data.events || Array.isArray(data.events))
        throw new Error("归档格式不兼容");
      this.archive = data;
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error(
          "赛事归档读取失败，请保留原文件并检查格式：" + e.message,
        );
    }
    this.lastError = "";
    this.closed = false;
    this.controllers = new Set();
  }
  settings() {
    return { ...DEFAULTS, ...this.config() };
  }
  close() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
  }
  async request(operation, variables) {
    if (this.closed) throw new Error("技能已停用");
    const key = JSON.stringify([operation, variables]);
    const cached = this.cache.get(key);
    const ttl = bounded(this.settings().cacheMinutes, 5, 1, 60) * 60000;
    if (cached && this.now() - cached.fetchedAtMs < ttl)
      return { ...cached, cache: true };
    if (this.inflight.has(key)) return this.inflight.get(key);
    const run = (async () => {
      try {
        const url = new URL("/api/gql", SOURCE);
        url.searchParams.set("operationName", operation);
        url.searchParams.set(
          "variables",
          JSON.stringify({ hl: "en-US", ...variables }),
        );
        url.searchParams.set(
          "extensions",
          JSON.stringify({
            persistedQuery: { version: 1, sha256Hash: operations[operation] },
          }),
        );
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 15000);
        let body;
        try {
          const response = await this.fetch(url, {
            signal: controller.signal,
            redirect: "error",
            headers: {
              "content-type": "application/json",
              "apollographql-client-name": "Esports Web",
              "apollographql-client-version": "1.0",
            },
          });
          if (!response.ok)
            throw new Error(
              `官网 HTTP ${response.status}${response.status === 429 ? "，请求过于频繁，请稍后重试" : ""}`,
            );
          const text = await response.text();
          if (text.length > 12000000) throw new Error("官网响应过大");
          body = JSON.parse(text);
        } finally {
          clearTimeout(timer);
          this.controllers.delete(controller);
        }
        if (body.errors?.length)
          throw new Error(
            "官网接口错误：" +
              body.errors
                .map((e) => e.message)
                .join("; ")
                .slice(0, 300),
          );
        if (!body.data) throw new Error("官网没有返回数据");
        const result = {
          data: clean(body.data),
          fetchedAt: new Date(this.now()).toISOString(),
          fetchedAtMs: this.now(),
          source: SOURCE,
          stale: false,
        };
        this.cache.set(key, result);
        if (this.cache.size > 100)
          this.cache.delete(this.cache.keys().next().value);
        return result;
      } catch (e) {
        this.lastError = e.message;
        if (cached)
          return { ...cached, cache: true, stale: true, warning: e.message };
        throw e;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run);
    return run;
  }
  async leagues() {
    const r = await this.request("homeLeagues", { sport: ["lol"] });
    if (!Array.isArray(r.data.leagues)) throw new Error("官网联赛格式已变化");
    return { ...r, items: r.data.leagues };
  }
  async leagueIds(input) {
    if (!String(input || "").trim()) return undefined;
    const aliases = {
      全球总决赛: "worlds",
      世界赛: "worlds",
      s赛: "worlds",
      季中赛: "msi",
      先锋赛: "first stand",
    };
    const names = String(input)
      .split(/[,，]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const { items } = await this.leagues();
    return names.map((n) => {
      const q = aliases[n] || n;
      const found = items.find((l) =>
        [l.id, l.name, l.slug].some((v) => String(v).toLowerCase() === q),
      );
      if (!found) throw new Error(`未找到联赛 ${n}，请先查询联赛列表`);
      return found.id;
    });
  }
  saveEvents(events, sync = null) {
    if (this.closed) return;
    for (const e of events)
      if (e.id) {
        const old = this.archive.events[e.id];
        if (old && Date.parse(old.fetchedAt) > Date.parse(e.fetchedAt))
          continue;
        this.archive.events[e.id] = {
          ...old,
          ...Object.fromEntries(
            Object.entries(e).filter(([, v]) => v !== undefined),
          ),
          league: { ...old?.league, ...e.league },
          tournament: { ...old?.tournament, ...e.tournament },
        };
      }
    const cutoff =
      this.now() -
      bounded(this.settings().retentionDays, 730, 30, 3650) * 86400000;
    this.archive.events = Object.fromEntries(
      Object.entries(this.archive.events)
        .filter(([, e]) => Date.parse(e.startTime) >= cutoff)
        .sort((a, b) => Date.parse(b[1].startTime) - Date.parse(a[1].startTime))
        .slice(0, 30000),
    );
    if (sync) this.archive.lastSync = sync;
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = this.file + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(this.archive));
    fs.renameSync(temp, this.file);
  }
  async schedule(args = {}) {
    const from = args.from || chinaDate(new Date(this.now()));
    const to = args.to || from;
    const range = dateRange(from, to);
    const leagues = await this.leagueIds(args.league);
    const events = new Map();
    const seen = new Set();
    let token;
    let truncated = false;
    let stale = false;
    let fetchedAt;
    let warning;
    for (
      let page = 0;
      page < bounded(this.settings().maxPages, 5, 1, 15);
      page++
    ) {
      const r = await this.request("homeEvents", {
        sport: ["lol"],
        eventType: "match",
        pageSize: 100,
        ...range,
        ...(leagues ? { leagues } : {}),
        ...(token ? { pageToken: token } : {}),
      });
      const data = r.data.esports;
      if (!Array.isArray(data?.events)) throw new Error("官网赛程格式已变化");
      stale ||= r.stale;
      warning ||= r.warning;
      fetchedAt = r.fetchedAt;
      const batch = data.events
        .filter((e) => e.type === "match" && e.id)
        .map((e) => normalizeEvent(e, r.fetchedAt));
      for (const e of batch) events.set(e.id, e);
      token = data.pages?.newer;
      truncated = !!token;
      if (!token) break;
      if (seen.has(token)) {
        warning = "官网返回重复分页标记，结果可能不完整";
        break;
      }
      seen.add(token);
    }
    const items = selectEvents([...events.values()], { ...args, from, to });
    this.saveEvents([...events.values()]);
    return {
      items,
      from,
      to,
      truncated,
      stale,
      warning,
      fetchedAt,
      source: SOURCE,
    };
  }
  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const today = this.now();
      const r = await this.schedule({
        from: chinaDate(new Date(today - 7 * 86400000)),
        to: chinaDate(new Date(today + 14 * 86400000)),
        league: this.settings().leagues,
      });
      if (!r.stale && !r.truncated) {
        this.lastError = "";
        this.saveEvents([], new Date(this.now()).toISOString());
      } else
        this.lastError = r.warning || "同步范围超过分页上限，部分数据未抓取";
      return r;
    })();
    try {
      return await this.syncing;
    } finally {
      this.syncing = null;
    }
  }
  async detail(id) {
    if (!/^\d+$/.test(String(id)))
      throw new Error("请使用赛程返回的数字赛事 id");
    const r = await this.request("watchVodQuery", { eventId: String(id) });
    const e = r.data.scheduledEvent;
    if (!e?.match) throw new Error("未找到该比赛");
    const item = normalizeEvent(e, r.fetchedAt);
    // 回放查询不返回比赛状态；只在官网明确给出胜负时确认已结束。
    if (item.teams.some((t) => t.result?.outcome === "win"))
      item.state = "completed";
    this.saveEvents([item]);
    return { ...r, item: this.archive.events[item.id] || item };
  }
}
