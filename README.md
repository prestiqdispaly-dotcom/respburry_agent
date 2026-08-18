# Cart agent

The service that runs inside the cart, on the Raspberry Pi. Two jobs, pointing
in opposite directions:

1. **It answers the dashboard's API.** Check now, Scan, Join and Push all arrive
   here as HTTP requests, in the wire format in
   [`../frontend/CART-BRIDGE.md`](../frontend/CART-BRIDGE.md).
2. **It holds the state the panels draw.** A push lands in memory and the guest
   screens read it from *here*, not from the API. That is what makes a cart in a
   field with no signal keep showing the right dishes.

Zero dependencies — plain `node:http`. Runs on a dev machine as a stand-in for
the Pi, and on the Pi as the real thing; the only difference is which OS
commands it shells out to.

**It invents nothing.** The network it reports is the machine's actual network:
`nmcli` on Linux, `netsh` on Windows. A machine with no wireless interface
honestly returns an empty scan, because there is no radio to see anything with.

## Run it

```bash
node --env-file=cart-agent/.env cart-agent/agent.mjs
```

From a fresh clone, or after resetting the database, put this cart's id and
device secret in `.env` first:

```js
// from the backend folder
db.carts.findOne({}, { _id: 1, deviceSecret: 1 })
```

`CART_ID` / `CART_SECRET` are only needed for the **cloud** route. The **direct**
route works without them.

## How a change reaches a screen

```
  operator taps "sold out"
        ↓
  API writes Mongo, records the change, and pushes the whole new state
        ↓
  agent stores it in memory and ticks `rev`
        ↓
  /screen/1 polls /state/1, sees a new rev, redraws
```

No button in between: every write auto-pushes. If the cart is off, the push
fails silently, the change stays queued, and the sync chip says so — press
**Push now** when it comes back.

## Endpoints

| Endpoint | Backs | Where the answer comes from |
|---|---|---|
| `GET /health` | **Check now**, first-run *Find the cart* | hostname, real OS uptime, SoC temp |
| `GET /network` | The **Cart network** summary | the machine's live interface and IP |
| `GET /network/scan` | **Scan** | `nmcli dev wifi list` / `netsh wlan show networks` |
| `POST /network/join` | **Join network** | `nmcli dev wifi connect`, reverts on failure |
| `POST /state` | Every write, and **Push now** | whole-state replacement, bumps `rev` |
| `GET /state` | — | the last pushed state, entire |
| `GET /state/:n` | **`/screen/:n`** | just what one panel draws |

It also calls the API's device routes: `POST /bridge/device/pair-code` at startup
and `POST /bridge/device/heartbeat` every 30 s. The cloud route goes stale 90 s
after the last beat, so stopping the agent is how you watch it drop.

## The guest screens

`/screen/1`, `/screen/2`, … are full-bleed panels with no navigation and no
sign-in — a screen bolted to a cart has no operator and no session to be signed
out of. Each polls `GET /state/:n` every two seconds and redraws only when `rev`
changes, so a change on Screen 3 does not flash Screen 1 at a guest.

In development, open `http://localhost:3001/screen/1` alongside the dashboard.

The allergen table rides along in the pushed state rather than being fetched: a
panel printing `da` instead of **Dairy** to a guest who cannot eat it is the one
failure this product cannot have, and a cart in a field has no API to ask.

## On the Pi

**One kiosk per connector.** A Pi 5 has 2 × micro-HDMI and 2 × MIPI DSI:

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars \
  --window-position=0,0    --app=http://localhost:3000/screen/1
chromium-browser --kiosk --window-position=1920,0 \
  --app=http://localhost:3000/screen/2
```

**Always on**, as a systemd unit:

```ini
[Unit]
Description=PRESTIQ cart agent
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/prestiq/cart-agent/agent.mjs
EnvironmentFile=/opt/prestiq/cart-agent/.env
Restart=always
User=prestiq

[Install]
WantedBy=multi-user.target
```

**Findable by name** — avahi advertises `prestiq-cart-01.local`, so the address
printed inside the cart lid stays true after DHCP hands out a new lease:

```bash
sudo hostnamectl set-hostname prestiq-cart-01
sudo apt install avahi-daemon
```

Set `CART_MODEL` to the real board (`Raspberry Pi 5 · 8 GB`) — the default says
"Simulated cart on <hostname>", which is honest on a laptop and wrong on a Pi.

`ALLOW_JOIN` defaults to **on** on Linux and **off** on Windows: switching the
radio is the whole point on a cart, and a good way to cut your own link on a dev
box.

## What survives a power cut

Everything a panel draws is on the cart, in `.cache/` beside this script:

| | |
|---|---|
| `state.json` | the last pushed menu, screens, brightness and allergen labels |
| `photos/` | a copy of every dish photo the menu currently uses |
| `photos.json` | which cached file belongs to which `/uploads/…` path |

Dish photos are the one part of the pushed state that is a URL rather than a
value, and the API serves them. So each push downloads any new ones and drops
the ones the menu stopped using; `GET /state/:n` then hands the panel a URL
pointing back at this agent instead of at the server.

The download runs in the background — the API calls a cart offline after four
seconds, and twenty photos do not arrive in four. A push whose photos have not
landed yet shows the dish without its picture for a moment, then the next poll
picks it up.

Verified end to end: with the API stopped and the agent restarted, a panel still
serves its dish, its allergen words, and its photo:

```
restored rev 1 from disk — 1 items, 1 photos
  ready: true    dish: Photo Test Dish    alg: Dairy
  photo: http://localhost:8080/photo/c6680587852db57a.png → 200 image/png
```

Cached filenames are derived from the source path, and an upload never reuses
one, so the photos are served `immutable` — a panel polling every two seconds
re-fetches nothing.
