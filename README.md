# homebridge-mrcool-cielo

A self-hosted Homebridge plugin for MrCool/Cielo mini splits and
thermostats — any device on your Cielo Home / MRCOOL SmartHVAC account.
Originally built for a MrCool DIY 5th-gen air handler with a Cielo Breez-i
WiFi dongle (model `diy-18-hp-wmah-230d25-0`), and also tested against a
Cielo Breez-Max mini-stat on the same account.

These devices have no local API — they only talk to Cielo's cloud
(`api.smartcielo.com` / `wss.smartcielo.com`), the same as the Cielo Home /
MRCOOL SmartHVAC apps. This plugin logs in through the same endpoint the
mobile app uses, which — unlike the web login at home.cielowigle.com — is not
gated by a CAPTCHA. It then holds a persistent WebSocket connection for
real-time control and state updates.

## Exposes in HomeKit

One accessory per indoor unit, containing:

- A **Heater/Cooler** service (the primary tile): on/off, Heat / Cool / Auto,
  current + target temperature, fan speed, swing.
- A **Dry Mode** switch, only if your unit supports it *and* you've turned on
  `exposeDryMode` in config (off by default — see below).

HomeKit's HeaterCooler service has no native "fan only" target state, and
fan-only mode is deliberately **not** exposed at all — a bolted-on separate
Fan service for just that one mode read as more confusing than useful. Dry
mode gets a plain switch since there's nowhere else for it to live, but it's
opt-in: a switch is a single accidental tap (or Siri misfire) away from
triggering, unlike Heat/Cool/Auto which live behind a deliberate mode picker.

Fan speed is exposed as `RotationSpeed` (only if the device reports
supporting adjustable fan speed) in four bands - `auto`/`low`/`medium`/`high`,
no separate "turbo" speed tier: 1-25% → auto, 26-50% → low, 51-75% → medium,
76-100% → high. Auto is deliberately not 0%, since HomeKit treats 0% as
equivalent to off.

Swing is exposed as the binary `SwingMode` characteristic (only if the
device reports supporting swing): enabled maps to the device's oscillating
"auto" swing, disabled maps to its first fixed position (e.g. "pos1") -
Cielo devices generally have no distinct "swing off" position of their own,
only a menu of fixed positions plus continuous oscillation.

## Setup

1. Install straight from this repo into wherever Homebridge scans for plugins
   (for the official Homebridge Docker image, that's the storage directory,
   e.g. `/var/lib/homebridge`; do **not** use `npm install -g`, which lands in
   the wrong path — see the actual working command below):
   ```
   npm install --prefix /var/lib/homebridge git+https://github.com/garrettgjb/hb_mrcool.git
   ```
   `dist/` is committed to this repo, so no build step runs on install.
2. Add a platform block to your Homebridge `config.json`:

   ```json
   {
     "platform": "MrCoolCielo",
     "name": "MrCool Cielo",
     "email": "your-cielo-account-email",
     "password": "your-cielo-account-password"
   }
   ```

   Use the same email/password you use to log into the Cielo Home or MRCOOL
   SmartHVAC app. With no `macAddress` set (as above), every device found on
   your account gets auto-registered as its own accessory — check the
   Homebridge log after starting for the list of what was found.

   To control only one specific device instead of all of them, add:
   ```json
   {
     "macAddress": "c4:d8:d5:18:b6:43"
   }
   ```

   Accessories are always named after the device's name in your Cielo
   account (e.g. "Living Room") - rename them directly in the Home app if
   you want something else.

   To expose the Dry Mode switch (off by default - see "Exposes in HomeKit"
   above for why), add:
   ```json
   {
     "exposeDryMode": true
   }
   ```

3. Restart Homebridge.

Access/refresh tokens are cached in Homebridge's storage directory
(`mrcool-cielo-tokens.json`) so it doesn't need to log in from scratch on
every restart.

## Updating

Re-run the same install command — it re-clones the latest commit:
```
npm install --prefix /var/lib/homebridge git+https://github.com/garrettgjb/hb_mrcool.git
```
Avoid `npm install -g` here too, and avoid running any `npm install` command
directly against `/var/lib/homebridge` for *other* reasons (e.g. installing
some unrelated package there) — it's a shared dependency tree with every
other Homebridge plugin's `package.json`/lockfile, and an unrelated install
can trigger a full tree reconciliation that touches other plugins' installed
files. If you need to test a change without touching that shared tree, clone
straight into the plugin's own folder instead:
```
rm -rf /var/lib/homebridge/node_modules/homebridge-mrcool-cielo
git clone https://github.com/garrettgjb/hb_mrcool.git /var/lib/homebridge/node_modules/homebridge-mrcool-cielo
```

## Debugging without Homebridge

`test-local.js` talks to Cielo's cloud directly, outside of Homebridge
entirely — much faster than a build-install-restart cycle for iterating on
the protocol:
```
CIELO_EMAIL="you@example.com" CIELO_PASSWORD="yourpassword" \
  CIELO_MAC="c4d8d518b643" CIELO_TEMP_F=70 \
  node test-local.js
```
Leave `CIELO_TEMP_F` unset to just log incoming broadcasts without sending
a command.

## MAC address handling

Cielo's API is case-sensitive about this in a way that fails silently if
you're not careful. Every `CieloDevice` tracks two forms of its MAC address:

- `macAddress` - normalized (lowercase, no separators). Used only for
  internal map keys and for matching the `macAddress` config option.
- `rawMacAddress` - Cielo's original casing/format as returned by its REST
  API (e.g. `C4D8D518B643`). Always use this one for anything sent to
  Cielo's cloud.

Sending the normalized (lowercase) MAC in an outgoing command doesn't
error - the websocket accepts it, the cloud responds normally, but it
never actually relays the command to the physical device. This was a real
bug (see `src/cieloApi.ts` comments near `rawMacAddress` and `connection_source`
for the other one like it) that took a while to track down specifically
*because* it fails silently instead of throwing or logging anything wrong.
If you're adding a new outgoing command type, use `rawMacAddress`, not
`macAddress`.

## Known limitations (v1)

- Turbo, display light, and FollowMe aren't exposed as HomeKit controls yet
  (swing now is). The underlying `latestAction` fields are preserved
  correctly on every command (not clobbered), so adding switches for these
  is straightforward - see `CieloApi.setSwing` in `src/cieloApi.ts` for the
  pattern to follow.
- This depends entirely on Cielo's cloud staying reachable and the
  reverse-engineered endpoints/payload quirks not changing. If Cielo changes
  their API, this plugin breaks until updated.
- Tested against a two-device Cielo account: a Breez-i dongle
  (`deviceTypeVersion: BI04`) and a Breez-Max mini-stat (`MSMT05`). Other
  device types/generations likely work (the protocol appears generic across
  Cielo's device catalog) but haven't been specifically verified.
