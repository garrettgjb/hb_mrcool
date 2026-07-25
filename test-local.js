// Standalone test script - bypasses Homebridge entirely so we can iterate on
// the Cielo protocol quickly. Reads credentials from env vars so they never
// need to be pasted into chat.
//
// Usage:
//   CIELO_EMAIL="you@example.com" CIELO_PASSWORD="yourpassword" \
//     CIELO_MAC="c4d8d518b643" CIELO_TEMP_F=70 \
//     /opt/homebrew/bin/node test-local.js
'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const IOS_X_API_KEY = 'T90bwfODtWaIUreVJtroN3itKWquNnUGRYiYUsf0';
const WEB_X_API_KEY = '3iCWYuBqpY2g7yRq3yyTk1XCS4CMjt1n9ECCjdpd';
const IOS_USER_AGENT = 'MRCOOL SmartHVAC/4.3.0 (com.smarthvac; build:2; iOS 26.5.0) Alamofire/5.9.1';
const WEB_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';
const URL_API = 'api.smartcielo.com';
const URL_API_WSS = 'wss.smartcielo.com'; // back to the host that actually accepts our connection
const URL_CIELO = 'https://home.cielowigle.com/';

const EMAIL = process.env.CIELO_EMAIL;
const PASSWORD = process.env.CIELO_PASSWORD;
const TARGET_MAC = (process.env.CIELO_MAC || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const TARGET_TEMP_F = process.env.CIELO_TEMP_F ? parseInt(process.env.CIELO_TEMP_F, 10) : null;

if (!EMAIL || !PASSWORD) {
  console.error('Set CIELO_EMAIL and CIELO_PASSWORD env vars.');
  process.exit(1);
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function login() {
  const pwdHash = crypto.createHash('sha256').update(PASSWORD, 'utf-8').digest('hex');
  const payload = {
    user: {
      isDeviceCountRequired: 1,
      isSmartHVAC: 1,
      ipAddress: '',
      deviceTokenId: 'N/A',
      mobileDeviceId: crypto.randomBytes(4).toString('hex').toUpperCase(),
      deviceType: 'iPhone17,1',
      appType: 'iOS',
      userId: EMAIL,
      password: pwdHash,
      timeZone: '-07:00',
      mobileDeviceName: 'iPhone',
      locale: 'en',
      appVersion: '4.3.0',
    },
  };
  const res = await fetch(`https://${URL_API}/user/smarthvac/login/1`, {
    method: 'POST',
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      'x-api-key': IOS_X_API_KEY,
      'user-agent': IOS_USER_AGENT,
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (body.status !== 200) throw new Error(`Login failed: ${body.message}`);
  const user = body.data.user;
  log('Logged in as', EMAIL);
  return {
    accessToken: user.accessToken,
    refreshToken: user.refreshToken,
    sessionId: user.sessionId || `hb-${Date.now()}`,
    userId: user.userId,
  };
}

async function getDevices(tokens) {
  const headers = {
    'content-type': 'application/json; charset=UTF-8',
    referer: URL_CIELO,
    origin: URL_CIELO,
    'user-agent': WEB_USER_AGENT,
    host: URL_API,
    authorization: tokens.accessToken,
    'x-api-key': WEB_X_API_KEY,
  };
  const res = await fetch(`https://${URL_API}/web/devices?limit=420`, { headers });
  const body = await res.json();
  if (body.status !== 200) throw new Error(`Device list failed: ${body.message}`);
  return body.data.listDevices;
}

async function main() {
  const tokens = await login();
  const devices = await getDevices(tokens);
  log(
    'Devices:',
    devices.map((d) => `${d.deviceName} (${d.macAddress})`).join(', '),
  );

  const device = TARGET_MAC
    ? devices.find((d) => d.macAddress.toLowerCase() === TARGET_MAC)
    : devices[0];
  if (!device) throw new Error(`Device ${TARGET_MAC} not found`);
  log('Using device:', device.deviceName, device.macAddress, 'applianceId', device.applianceId);

  const wsUri = `wss://${URL_API_WSS}/websocket/?sessionId=${encodeURIComponent(
    tokens.sessionId,
  )}&token=${encodeURIComponent(tokens.accessToken)}`;
  log('Connecting to', wsUri);

  const ws = new WebSocket(wsUri, {
    headers: {
      Host: URL_API_WSS,
      'Cache-control': 'no-cache',
      Pragma: 'no-cache',
      'User-agent': WEB_USER_AGENT,
      Origin: URL_CIELO.slice(0, -1),
    },
  });

  let lastTs = 0;
  function nextTs() {
    let ts = Math.floor(Date.now() / 1000);
    if (ts === lastTs) ts += 1;
    lastTs = ts;
    return ts;
  }

  ws.on('open', () => {
    log('WebSocket OPEN');

    if (TARGET_TEMP_F) {
      const actions = {
        power: device.latestAction.power,
        mode: device.latestAction.mode,
        fanspeed: device.latestAction.fanspeed,
        temp: String(TARGET_TEMP_F),
        // Preserving real current values this time (not hardcoded) to test
        // whether that's actually compatible with connection_source:0 + the
        // correct macAddress casing.
        swing: device.latestAction.swing,
        swinginternal: '',
        turbo: device.latestAction.turbo,
        light: device.latestAction.light,
        followme: device.latestAction.followme,
      };
      const msg = {
        action: 'actionControl',
        actionSource: 'WEB',
        applianceType: device.applianceType,
        macAddress: device.macAddress,
        deviceTypeVersion: device.deviceTypeVersion,
        fwVersion: device.fwVersion,
        applianceId: device.applianceId,
        actionType: 'temp',
        actionValue: String(TARGET_TEMP_F),
        connection_source: 0,
        user_id: tokens.userId,
        preset: 0,
        oldPower: device.latestAction.power,
        myRuleConfiguration: {},
        mid: 'WEB',
        actions,
        application_version: '1.4.4',
        ts: nextTs(),
      };
      const raw = JSON.stringify(msg);
      log('SENDING ->', raw);
      ws.send(raw);
    } else {
      log('No CIELO_TEMP_F set, just listening for broadcasts. Ctrl+C to quit.');
    }
  });

  ws.on('message', (data) => {
    log('RECEIVED <-', data.toString());
  });

  ws.on('close', (code, reason) => log('WebSocket CLOSED', code, reason?.toString()));
  ws.on('error', (err) => log('WebSocket ERROR', err));

  // Keep the process alive for a bit to catch the async StateUpdate ack.
  setTimeout(() => {
    log('Test window elapsed, exiting.');
    process.exit(0);
  }, 45000);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
