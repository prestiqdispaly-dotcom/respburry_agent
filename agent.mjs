/**
 * The cart agent — the service that runs inside the cart, on the Raspberry Pi.
 *
 * Two jobs, and they point in opposite directions:
 *
 *   1. It answers the dashboard's API. Check now, Scan, Join and Push all end up
 *      as HTTP requests here, in the wire format in CART-BRIDGE.md.
 *   2. It holds the state the panels draw. A push lands in memory and the guest
 *      screens read it from here — not from the API — so a cart in a field with
 *      no internet keeps showing the right dishes.
 *
 * It invents nothing. The network it reports is the machine's actual network,
 * read from the OS: `nmcli` on the Pi, `netsh` on a Windows dev box. A machine
 * with no wireless interface honestly returns an empty scan, because there is
 * no radio to see anything with.
 *
 *   node --env-file=cart-agent/.env cart-agent/agent.mjs
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { networkInterfaces, hostname, uptime } from "node:os";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const exec = promisify(execFile);
const IS_WINDOWS = process.platform === "win32";
const HERE = dirname(fileURLToPath(import.meta.url));

// ─── Configuration ────────────────────────────────────────────────────────────

const PORT = Number(process.env.CART_AGENT_PORT || 8080);
const API_URL = process.env.API_URL || "http://localhost:6060/api/v1";
const CART_ID = process.env.CART_ID || "";
const CART_SECRET = process.env.CART_SECRET || "";
const CART_NAME = process.env.CART_NAME || "PRESTIQ Cart 01";
const WIFI_DEV = process.env.WIFI_DEV || "wlan0";

/** `http://host:6060/api/v1` → `http://host:6060`, where `/uploads/…` lives. */
const API_ORIGIN = API_URL.replace(/\/api\/v1\/?$/, "");

/**
 * On-disk cache, so a cart that reboots in a field comes back up showing the
 * menu rather than waiting for a server it cannot reach.
 */
const CACHE_DIR = process.env.CART_CACHE_DIR || join(HERE, ".cache");
const PHOTO_DIR = join(CACHE_DIR, "photos");
const STATE_FILE = join(CACHE_DIR, "state.json");
const PHOTO_INDEX = join(CACHE_DIR, "photos.json");

/**
 * Joining a network is a real change to whatever machine this runs on. On a Pi
 * bolted inside a cart that is the whole point; on the laptop you are working
 * from it can drop the link this request arrived over. Off unless asked for,
 * and on by default on Linux, where this file is meant to live.
 */
const ALLOW_JOIN =
  process.env.ALLOW_JOIN === undefined
    ? !IS_WINDOWS
    : String(process.env.ALLOW_JOIN).toLowerCase() === "true";

/** The cloud route dies 90s after the last check-in, so beat well inside that. */
const HEARTBEAT_MS = 30_000;
/** A code lives ten minutes; refresh before it lapses so one is always live. */
const PAIR_CODE_REFRESH_MS = 9 * 60_000;

/**
 * What this thing says it is. On a dev box it must not claim to be hardware
 * that is not in the room — the identity line is printed on the Connection
 * card. On a Pi, set CART_MODEL to the real board.
 */
const MODEL = process.env.CART_MODEL || `Simulated cart on ${hostname()}`;
const AGENT_VERSION = process.env.CART_AGENT_VERSION || "sim";

// ─── The state the panels draw ────────────────────────────────────────────────

/**
 * The last state the dashboard pushed, and a revision that ticks with it.
 *
 * The screens poll `rev` rather than the whole payload: a panel showing one
 * dish should not re-render, re-decode its photo and flash at a guest because
 * something changed on Screen 3.
 */
let state = null;
let rev = 0;
let pushedAt = null;

/**
 * How many panels the cart drives. Left unset until a push says so: the Pi's
 * count is authoritative and overwrites the dashboard's, so an agent that
 * cannot actually count video ports must not answer the question.
 */
let screenCount = null;

// ─── Dish photos, kept on the cart ────────────────────────────────────────────

/**
 * Source path (`/uploads/dishes/dish-123.jpg`) → the file cached beside this
 * script. Photos are served by the API, so without this a panel on a cart with
 * no route back to the server shows a dish with no picture — the one part of
 * the state that is a URL rather than a value.
 *
 * Keyed by path rather than by content, which is safe because an upload never
 * reuses a filename: multer stamps every one with a timestamp and a random
 * suffix, so a replaced photo always arrives as a new path.
 */
const photos = new Map();

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/**
 * Which photos this cart has to hold a copy of.
 *
 * Two shapes arrive, depending on where the API stores its uploads:
 * `/uploads/dishes/…` when they sit on the server's own disk, and an absolute
 * `https://res.cloudinary.com/…` when they do not. Both are equally unreachable
 * from a field with no signal, so both get cached.
 *
 * Shipped artwork (`/dishes/i1.svg`) is a frontend asset served by whatever is
 * showing the panel, and needs no cache.
 */
const isUpload = (path) =>
  typeof path === "string" &&
  (path.startsWith("/uploads") || /^https?:\/\//i.test(path));

/** An absolute source path, whichever of the two shapes it arrived in. */
const urlOf = (src) => (/^https?:\/\//i.test(src) ? src : `${API_ORIGIN}${src}`);

/**
 * A stable local filename for a source.
 *
 * The extension is read from the path only — a query string is not part of the
 * file's type, and a Cloudinary URL that carries one would otherwise produce a
 * name ending in `.jpg?v=2`, which no MIME lookup and no route pattern matches.
 */
const cacheNameOf = (src) => {
  const withoutQuery = src.split(/[?#]/)[0];
  return (
    createHash("sha1").update(src).digest("hex").slice(0, 16) +
    (extname(withoutQuery).toLowerCase() || ".jpg")
  );
};

const fetchPhoto = async (src) => {
  try {
    const res = await fetch(urlOf(src));
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const name = cacheNameOf(src);
    await writeFile(join(PHOTO_DIR, name), bytes);
    log(`cached ${src} (${Math.round(bytes.length / 1024)} kB)`);
    return name;
  } catch {
    // The server is unreachable — which is precisely the case this cache is
    // for. Whatever is already on disk stays, and the next push tries again.
    return null;
  }
};

/**
 * Pull down anything new in this push, then drop what the menu no longer uses.
 *
 * Deliberately not awaited by `POST /state`: the API gives that request four
 * seconds before it calls the cart offline, and a menu of twenty photos does
 * not download in four seconds.
 */
const cachePhotos = async (items) => {
  const wanted = new Set();

  for (const item of items) {
    const src = item?.photo;
    if (!isUpload(src)) continue;

    let name = photos.get(src);
    if (!name) {
      name = await fetchPhoto(src);
      if (name) photos.set(src, name);
    }
    if (name) wanted.add(name);
  }

  for (const [src, name] of photos) {
    if (!wanted.has(name)) photos.delete(src);
  }

  try {
    for (const file of await readdir(PHOTO_DIR)) {
      if (!wanted.has(file)) await unlink(join(PHOTO_DIR, file));
    }
    await writeFile(PHOTO_INDEX, JSON.stringify(Object.fromEntries(photos)));
  } catch {
    // A cache that cannot be tidied is still a working cache.
  }
};

/**
 * Point an item's photo at this agent when we hold a copy.
 *
 * An absolute URL built from the request's own Host header, so the panel loads
 * the picture from wherever it just reached us — `localhost:8080` on a dev box,
 * `prestiq-cart-01.local:8080` in a venue — without either side being told.
 */
const withCachedPhoto = (item, origin) => {
  if (!item) return item;
  const name = photos.get(item.photo);
  return name ? { ...item, photo: `${origin}/photo/${name}` } : item;
};

/** Bring the last push and its pictures back after a power cut. */
const loadCache = async () => {
  await mkdir(PHOTO_DIR, { recursive: true });

  try {
    const index = JSON.parse(await readFile(PHOTO_INDEX, "utf8"));
    for (const [src, name] of Object.entries(index)) photos.set(src, name);
  } catch {
    // No index yet — first boot.
  }

  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    state = saved.state ?? null;
    rev = saved.rev ?? 0;
    pushedAt = saved.pushedAt ?? null;
    if (state?.screenCount) screenCount = state.screenCount;
    if (state) {
      const items = Array.isArray(state.items) ? state.items.length : 0;
      log(`restored rev ${rev} from disk — ${items} items, ${photos.size} photos`);
    }
  } catch {
    // Never pushed to, or the file is unreadable. The panels say so.
  }
};

const saveState = async () => {
  try {
    await writeFile(STATE_FILE, JSON.stringify({ state, rev, pushedAt }));
  } catch {
    // A cart that cannot write its cache still serves this session from memory.
  }
};

// ─── Reading this machine's real network ──────────────────────────────────────

/** The first non-internal IPv4 address — the address the cart is reachable at. */
const localIp = () => {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "";
};

/** Run a command and hand back its output; a missing tool is not a crash. */
const cmd = async (bin, args) => {
  try {
    const { stdout } = await exec(bin, args, { windowsHide: true });
    return stdout;
  } catch (err) {
    // A missing adapter is reported on stdout with a zero exit on some builds
    // and as a failure on others; both mean the same thing.
    return err?.stdout ?? "";
  }
};

const NO_RADIO = /no wireless interface|not authorized|no device/i;

/** Both tools report strength as a percentage; the contract wants bars, 1–4. */
const barsOf = (percent) => Math.max(1, Math.min(4, Math.ceil(percent / 25)));

/** `  Key   : value` → value, for the first matching key. */
const field = (block, key) => {
  const match = block.match(new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
};

/** `nmcli -t` escapes colons inside values; unescape before splitting on them. */
const nmFields = (line) =>
  line.split(/(?<!\\):/).map((part) => part.replace(/\\:/g, ":"));

/**
 * What the cart is on right now.
 *
 * Wireless if this machine has a radio and it is associated; otherwise the wired
 * address it actually holds. `hotspot` only when there is no address at all,
 * which is the same corner a real cart falls into with nothing in range.
 */
const currentNetwork = async () => {
  const ip = localIp();

  if (IS_WINDOWS) {
    const out = await cmd("netsh", ["wlan", "show", "interfaces"]);
    if (out && !NO_RADIO.test(out)) {
      const ssid = field(out, "SSID");
      if (ssid && /connected/i.test(field(out, "State"))) {
        const signal = parseInt(field(out, "Signal"), 10);
        return {
          mode: "wifi",
          ssid,
          ip,
          signal: Number.isFinite(signal) ? barsOf(signal) : 4,
        };
      }
    }
  } else {
    const out = await cmd("nmcli", ["-t", "-f", "ACTIVE,SSID,SIGNAL", "dev", "wifi"]);
    for (const line of out.split("\n")) {
      const [active, ssid, signal] = nmFields(line.trim());
      if (active === "yes" && ssid) {
        const percent = Number(signal);
        return {
          mode: "wifi",
          ssid,
          ip,
          signal: Number.isFinite(percent) ? barsOf(percent) : 4,
        };
      }
    }
  }

  if (ip) return { mode: "ethernet", ssid: "", ip, signal: 4 };
  return { mode: "hotspot", ssid: "", ip: "", signal: 4 };
};

/**
 * A real scan — `nmcli dev wifi list` on the Pi, `netsh` on Windows.
 *
 * No radio means an empty list, and the dashboard says so in as many words. An
 * invented list here would be the one thing this file exists to avoid.
 */
const scanNetworks = async () => {
  const seen = new Map();
  const remember = (ssid, percent, secured) => {
    if (!ssid) return;
    const previous = seen.get(ssid);
    // Duplicates merged, strongest BSSID wins — one row per network name.
    if (previous && previous.percent >= percent) return;
    seen.set(ssid, { ssid, signal: barsOf(percent), secured, percent });
  };

  if (IS_WINDOWS) {
    const out = await cmd("netsh", ["wlan", "show", "networks", "mode=bssid"]);
    if (!out || NO_RADIO.test(out)) return [];

    for (const block of out.split(/^SSID \d+ : /m).slice(1)) {
      const auth = field(block, "Authentication");
      const percents = [...block.matchAll(/^\s*Signal\s*:\s*(\d+)%/gim)].map((m) =>
        Number(m[1]),
      );
      remember(
        block.split("\n")[0].trim(),
        percents.length ? Math.max(...percents) : 0,
        !!auth && !/^open$/i.test(auth),
      );
    }
  } else {
    const out = await cmd("nmcli", [
      "-t",
      "-f",
      "SSID,SIGNAL,SECURITY",
      "dev",
      "wifi",
      "list",
      "--rescan",
      "yes",
    ]);
    if (!out || NO_RADIO.test(out)) return [];

    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [ssid, signal, security] = nmFields(line.trim());
      remember(ssid, Number(signal) || 0, !!security && security !== "--");
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 20)
    .map(({ ssid, signal, secured }) => ({ ssid, signal, secured }));
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const log = (...parts) => {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`  ${t}  ${parts.join(" ")}`);
};

const CORS = {
  // The guest screens are served from wherever the dashboard is — a Next dev
  // server in development, the Pi itself in a venue. Both need to read /state.
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET,POST,OPTIONS",
};

const send = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // The screens poll this; a cached answer is a panel that never changes.
    "cache-control": "no-store",
  });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

// ─── The endpoints the API calls ──────────────────────────────────────────────

const routes = {
  /** Backs **Check now** and the first-run "Find the cart" step. */
  "GET /health": async () => [
    200,
    {
      cartId: CART_ID || "cart-01",
      name: CART_NAME,
      model: MODEL,
      agentVersion: AGENT_VERSION,
      // The machine's real uptime, not this process's — a cart that has been
      // powered on all day is what the number is meant to convey.
      uptimeSeconds: Math.floor(uptime()),
      ...(screenCount ? { screenCount } : {}),
      // In the contract, and honestly empty on a box with no thermal sensor.
      temperatureC: await cpuTemperature(),
    },
  ],

  /** Backs the **Cart network** summary. */
  "GET /network": async () => [200, await currentNetwork()],

  /** Backs **Scan**. */
  "GET /network/scan": async () => {
    const found = await scanNetworks();
    log(`scan → ${found.length} network${found.length === 1 ? "" : "s"}`);
    return [200, found];
  },

  /**
   * Backs **Join network**.
   *
   * The cart must not strand itself: if the new network fails to come up the
   * radio is put back on whatever it was on before. A cart that joined a wrong
   * password and disappeared is a dead cart at a live event.
   */
  "POST /network/join": async (body) => {
    const ssid = String(body?.ssid ?? "");
    const password = String(body?.password ?? "");

    if (!ALLOW_JOIN) {
      return [
        403,
        {
          error:
            `This agent is standing in for the cart, and joining ${ssid} would ` +
            `move this computer's own network. Set ALLOW_JOIN=true to permit it.`,
        },
      ];
    }
    if (IS_WINDOWS) {
      // `netsh wlan connect` can only use a profile the machine already stores;
      // writing a profile XML would mean putting the key on disk, which the
      // contract forbids.
      const out = await cmd("netsh", ["wlan", "connect", `name=${ssid}`]);
      if (!/completed successfully/i.test(out)) {
        return [
          400,
          {
            error:
              `Could not join ${ssid}. This host can only reconnect to networks ` +
              `it already has a saved profile for.`,
          },
        ];
      }
    } else {
      const before = await currentNetwork();
      const args = ["dev", "wifi", "connect", ssid, "ifname", WIFI_DEV];
      if (password) args.push("password", password);
      const out = await cmd("nmcli", args);

      if (!/successfully activated/i.test(out)) {
        // Put the radio back where it was rather than leaving it down.
        if (before.mode === "wifi" && before.ssid) {
          await cmd("nmcli", ["con", "up", before.ssid]);
        }
        log(`join ${ssid} failed — reverted to ${before.ssid || before.mode}`);
        return [
          400,
          { error: `Could not join ${ssid} — check the password and try again` },
        ];
      }
    }

    const network = await currentNetwork();
    log(`joined ${network.ssid} → ${network.ip}`);
    return [200, network];
  },

  /**
   * Backs **Push now** and every write behind it.
   *
   * The dashboard sends the state the cart should be in, not a replay of the
   * taps that got there, so this is a whole-state replacement rather than a
   * merge. `rev` ticks so the panels know to redraw.
   */
  "POST /state": async (body) => {
    state = body ?? {};
    rev += 1;
    pushedAt = new Date().toISOString();
    if (state.screenCount) screenCount = state.screenCount;

    const items = Array.isArray(state.items) ? state.items : [];
    const live = items.filter((i) => i.active && i.screen > 0).length;
    log(
      `state rev ${rev} — ${items.length} item${items.length === 1 ? "" : "s"},`,
      `${live} on screen, ${state.screenCount ?? "?"} panels, ${state.orientation ?? "?"}`,
    );

    // Both in the background: the API calls the cart offline after four
    // seconds, and neither of these is worth being called offline over.
    void saveState();
    void cachePhotos(items);

    return [200, { ok: true, rev, applied: items.length }];
  },

  /** Everything at once — for a panel that draws more than one screen. */
  "GET /state": async (_body, ctx) => [
    200,
    {
      rev,
      pushedAt,
      ...(state ?? {}),
      items: (state?.items ?? []).map((i) => withCachedPhoto(i, ctx.origin)),
    },
  ],
};

/**
 * One panel's worth of state.
 *
 * A screen asks only about itself, so it is handed only what it draws. The
 * allergen table rides along because a panel that cannot reach the API must
 * still print "Dairy" rather than the code `da`.
 */
const screenState = (n, origin) => {
  const items = Array.isArray(state?.items) ? state.items : [];
  const item = items.find((i) => i.screen === n && i.active) ?? null;

  return {
    rev,
    pushedAt,
    screen: n,
    cartName: state?.cartName ?? CART_NAME,
    screenCount: state?.screenCount ?? screenCount ?? 0,
    orientation: state?.orientation ?? "Landscape",
    brightness: state?.brightness?.[String(n)] ?? 80,
    allergens: state?.allergens ?? [],
    item: withCachedPhoto(item, origin),
    // A cart that has never been pushed to is not the same as one showing
    // nothing, and the panel says so rather than sitting blank.
    ready: state !== null,
  };
};

// ─── Server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const key = `${req.method} ${path}`;
  const origin = `http://${req.headers.host || `localhost:${PORT}`}`;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  // `GET /state/3` — one panel's worth.
  const panel = req.method === "GET" && path.match(/^\/state\/(\d+)$/);
  if (panel) return send(res, 200, screenState(Number(panel[1]), origin));

  // `GET /photo/<name>` — a cached dish photo. The name is one this agent
  // generated, and the pattern is checked rather than trusted: a path handed
  // straight to the filesystem is how a request for `../../etc/passwd` works.
  const photo = req.method === "GET" && path.match(/^\/photo\/([a-f0-9]{16}\.[a-z]+)$/);
  if (photo) return sendPhoto(res, photo[1]);

  const handler = routes[key];
  if (!handler) {
    log(`${key} → 404`);
    return send(res, 404, { error: `No such endpoint: ${key}` });
  }

  const body = req.method === "POST" ? await readBody(req) : null;
  const [status, payload] = await handler(body, { origin });
  if (key !== "GET /health" && key !== "GET /state") log(`${key} → ${status}`);
  send(res, status, payload);
});

/**
 * Serve a cached photo.
 *
 * Cached hard by the browser: the name is derived from the source path, and an
 * upload never reuses one, so a picture at this URL can never change. That
 * matters on a panel — re-fetching a 4 MB plate every two seconds because the
 * poll returned a new revision would make the screen flicker on a fast cart and
 * stall on a slow one.
 */
async function sendPhoto(res, name) {
  try {
    const bytes = await readFile(join(PHOTO_DIR, name));
    res.writeHead(200, {
      ...CORS,
      "content-type": MIME[extname(name)] ?? "application/octet-stream",
      "content-length": bytes.length,
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(bytes);
  } catch {
    send(res, 404, { error: "No such photo on this cart" });
  }
}

/** The Pi exposes its SoC temperature; a laptop generally does not. */
async function cpuTemperature() {
  if (IS_WINDOWS) return null;
  const raw = await cmd("cat", ["/sys/class/thermal/thermal_zone0/temp"]);
  const milli = Number(String(raw).trim());
  return Number.isFinite(milli) && milli > 0 ? Math.round(milli / 100) / 10 : null;
}

await loadCache();

server.listen(PORT, async () => {
  const network = await currentNetwork();
  console.log("");
  console.log(`  PRESTIQ cart agent — ${MODEL} · agent ${AGENT_VERSION}`);
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log(`  Cart address to enter in the dashboard: localhost:${PORT}`);
  console.log(
    `  Network (read from this machine): ${network.mode} · ${network.ssid || "—"} · ${network.ip || "no address"}`,
  );
  if (network.mode !== "wifi") {
    console.log("  No wireless association here, so Scan may honestly return nothing.");
  }
  console.log(`  Guest screens read: http://localhost:${PORT}/state/1`);
  console.log("");
  startCloudRoute();
});

// ─── The cloud route: the agent dials out ─────────────────────────────────────

/**
 * The direct route needs nothing from us — the API calls in. The cloud route is
 * the other way round: the cart reports in, and the dashboard reads what it last
 * said. Both need CART_ID and CART_SECRET, burned in at provisioning.
 */
function startCloudRoute() {
  if (!CART_ID || !CART_SECRET) {
    console.log("  Cloud route off — set CART_ID and CART_SECRET to enable it.");
    console.log("  The direct route works without them.");
    console.log("");
    return;
  }

  const device = async (path, body) => {
    const res = await fetch(`${API_URL}/bridge/device/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cart-id": CART_ID,
        "x-cart-secret": CART_SECRET,
      },
      body: JSON.stringify(body ?? {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.message || `HTTP ${res.status}`);
    return json;
  };

  const showPairCode = async () => {
    try {
      const { data } = await device("pair-code");
      console.log("");
      console.log("  ┌────────────────────────────────────┐");
      console.log(`  │  SCREEN 1:  ${data.code}                │`);
      console.log("  └────────────────────────────────────┘");
      console.log(`  Valid ${data.expiresInMinutes} minutes. Type it into "Pairing code".`);
      console.log("");
    } catch (err) {
      log(`pair-code failed — ${err.message}`);
    }
  };

  const beat = async () => {
    try {
      await device("heartbeat", {
        model: MODEL,
        agentVersion: AGENT_VERSION,
        ...(screenCount ? { screenCount } : {}),
        network: await currentNetwork(),
      });
    } catch (err) {
      log(`heartbeat failed — ${err.message}`);
    }
  };

  void showPairCode();
  void beat();
  setInterval(beat, HEARTBEAT_MS).unref?.();
  setInterval(showPairCode, PAIR_CODE_REFRESH_MS).unref?.();
}

const stop = () => {
  console.log("\n  Cart agent stopped.\n");
  server.close(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
