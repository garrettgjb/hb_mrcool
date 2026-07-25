import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs';
import WebSocket from 'ws';
import type { Logging } from 'homebridge';
import {
  URL_API,
  URL_API_WSS,
  URL_CIELO,
  URL_API_LOGIN,
  URL_API_REFRESH,
  URL_API_DEVICES,
  URL_API_APPLIANCE_INFO,
  IOS_X_API_KEY,
  WEB_X_API_KEY,
  IOS_USER_AGENT,
  WEB_USER_AGENT,
  TIME_REFRESH_TOKEN_SEC,
  TIMER_PING_SEC,
  TIMER_PONG_TIMEOUT_SEC,
  RECONNECT_BASE_DELAY_SEC,
  RECONNECT_MAX_DELAY_SEC,
} from './settings';

export interface CieloLatestAction {
  power: string;
  mode: string;
  fanspeed: string;
  temp: string;
  swing: string;
  swinginternal?: string;
  turbo?: string;
  light?: string;
  followme?: string;
  preset?: number;
}

export interface CieloAppliance {
  applianceId: number;
  mode: string; // colon-separated list of supported modes, or literally "mode" for single-mode units
  fan: string; // colon-separated list of supported fan speeds
  swing?: string;
  temp: string; // "min:max" range, or "inc:dec" if there's no direct setpoint
  tempIncrement: number;
  isFaren: number;
}

export interface CieloDevice {
  /** Normalized (lowercase, no separators) - used for internal map keys and config matching only. */
  macAddress: string;
  /**
   * Exact original casing/format as returned by Cielo's REST API (e.g.
   * "C4D8D518B643"). Cielo's backend silently drops actionControl commands
   * that don't echo this exact casing back - it does not relay to the
   * physical device, with no error, if macAddress is lowercased. Always use
   * this field (never `macAddress`) when building outgoing commands.
   */
  rawMacAddress: string;
  deviceName: string;
  applianceId: number;
  applianceType: string;
  fwVersion: string;
  deviceTypeVersion: string;
  connectionSource: number;
  deviceStatus: number;
  isFaren: number;
  latestAction: CieloLatestAction;
  latEnv: { temp: number; humidity: number };
  appliance: CieloAppliance;
  myRuleConfiguration?: Record<string, unknown>;
  // Last power state confirmed by the cloud (as opposed to what we've
  // optimistically set locally) — the cloud protocol wants this on every
  // command so it can detect on/off transitions.
  confirmedPower: string;
}

interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  userId: string;
}

type ActionType = 'power' | 'mode' | 'fanspeed' | 'temp' | 'swing';

export class CieloApi extends EventEmitter {
  private accessToken = '';
  private refreshTokenValue = '';
  private sessionId = '';
  private userId = '';
  private tokenExpireAtSec = 0;

  private devices = new Map<string, CieloDevice>();

  private ws: WebSocket | null = null;
  private wsIntentionalClose = false;
  private reconnectAttempts = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private tokenCheckTimer: NodeJS.Timeout | null = null;
  private lastMessageAtMs = 0;
  private lastSentTsSec = 0;

  constructor(
    private readonly log: Logging,
    private readonly email: string,
    private readonly password: string,
    private readonly tokenStoragePath: string,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (!(await this.tryPersistedTokens())) {
      await this.login();
    }
    await this.refreshDeviceList();
    this.connectWebSocket();
    this.tokenCheckTimer = setInterval(() => this.checkTokenExpiry(), 60_000);
  }

  stop(): void {
    this.wsIntentionalClose = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.tokenCheckTimer) clearInterval(this.tokenCheckTimer);
    this.ws?.close();
  }

  getDevice(macAddress: string): CieloDevice | undefined {
    return this.devices.get(normalizeMac(macAddress));
  }

  getAllDevices(): CieloDevice[] {
    return Array.from(this.devices.values());
  }

  // ---------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------

  private async tryPersistedTokens(): Promise<boolean> {
    try {
      const raw = fs.readFileSync(this.tokenStoragePath, 'utf-8');
      const tokens: TokenBundle = JSON.parse(raw);
      this.applyTokens(tokens);
      // Confirm the persisted tokens are actually still valid before relying
      // on them for the rest of startup.
      const ok = await this.refreshToken();
      return ok;
    } catch {
      return false;
    }
  }

  private applyTokens(tokens: TokenBundle): void {
    this.accessToken = tokens.accessToken;
    this.refreshTokenValue = tokens.refreshToken;
    this.sessionId = tokens.sessionId;
    this.userId = tokens.userId;
    this.tokenExpireAtSec = nowSec() + TIME_REFRESH_TOKEN_SEC;
  }

  private persistTokens(): void {
    const bundle: TokenBundle = {
      accessToken: this.accessToken,
      refreshToken: this.refreshTokenValue,
      sessionId: this.sessionId,
      userId: this.userId,
    };
    try {
      fs.writeFileSync(this.tokenStoragePath, JSON.stringify(bundle), { mode: 0o600 });
    } catch (err) {
      this.log.warn('Could not persist Cielo tokens to disk: %s', err);
    }
  }

  // Logs in via the mobile app's endpoint. Unlike the web login used by
  // home.cielowigle.com, this one is not behind a CAPTCHA.
  private async login(): Promise<void> {
    const pwdHash = crypto.createHash('sha256').update(this.password, 'utf-8').digest('hex');
    const payload = {
      user: {
        isDeviceCountRequired: 1,
        isSmartHVAC: 1,
        ipAddress: '',
        deviceTokenId: 'N/A',
        mobileDeviceId: crypto.randomBytes(4).toString('hex').toUpperCase(),
        deviceType: 'iPhone17,1',
        appType: 'iOS',
        userId: this.email,
        password: pwdHash,
        timeZone: formatTzOffset(),
        mobileDeviceName: 'iPhone',
        locale: 'en',
        appVersion: '4.3.0',
      },
    };

    const res = await fetch(`https://${URL_API}/${URL_API_LOGIN}`, {
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        'x-api-key': IOS_X_API_KEY,
        'user-agent': IOS_USER_AGENT,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`Cielo login failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as any;
    if (body.status !== 200) {
      throw new Error(`Cielo login failed: ${body.message}`);
    }

    const user = body.data.user;
    this.applyTokens({
      accessToken: user.accessToken,
      refreshToken: user.refreshToken,
      sessionId: user.sessionId || `hb-${Date.now()}`,
      userId: user.userId,
    });
    this.persistTokens();
    this.log.info('Logged in to Cielo cloud as %s', this.email);
  }

  private async refreshToken(): Promise<boolean> {
    try {
      const res = await fetch(`https://${URL_API}/${URL_API_REFRESH}`, {
        method: 'POST',
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          'x-api-key': IOS_X_API_KEY,
          'user-agent': IOS_USER_AGENT,
          authorization: this.accessToken,
        },
        body: JSON.stringify({ refreshToken: this.refreshTokenValue }),
      });
      if (!res.ok) {
        this.log.warn('Cielo token refresh failed: HTTP %s', res.status);
        return false;
      }
      const body = (await res.json()) as any;
      if (body.status !== 200 || body.message !== 'SUCCESS') {
        this.log.warn('Cielo token refresh failed: %s', body.message);
        return false;
      }
      this.accessToken = body.data.accessToken;
      this.refreshTokenValue = body.data.refreshToken;
      this.tokenExpireAtSec = nowSec() + TIME_REFRESH_TOKEN_SEC;
      this.persistTokens();
      return true;
    } catch (err) {
      this.log.warn('Cielo token refresh error: %s', err);
      return false;
    }
  }

  private checkTokenExpiry(): void {
    if (nowSec() > this.tokenExpireAtSec) {
      this.refreshToken().then((ok) => {
        if (ok) {
          // Force a reconnect so the websocket picks up the new token.
          this.ws?.close();
        }
      });
    }
  }

  // ---------------------------------------------------------------------
  // Device list (REST)
  // ---------------------------------------------------------------------

  async refreshDeviceList(): Promise<void> {
    const devices = await this.getDevicesRest();
    const applianceIds = Array.from(
      new Set(devices.map((d) => String(d.applianceId)).filter((id) => id && id !== '0')),
    );
    const appliances = applianceIds.length ? await this.getApplianceInfoRest(applianceIds) : [];

    for (const raw of devices) {
      const applianceId = String(raw.applianceId);
      if (!applianceId || applianceId === '0') {
        this.log.warn("Device '%s' has no supported appliance, skipping", raw.deviceName);
        continue;
      }
      const appliance = appliances.find((a: any) => String(a.applianceId) === applianceId);
      if (!appliance) {
        this.log.warn('No appliance data found for device %s', raw.deviceName);
        continue;
      }

      const mac = normalizeMac(raw.macAddress);
      const existing = this.devices.get(mac);
      const device: CieloDevice = {
        macAddress: mac,
        rawMacAddress: raw.macAddress,
        deviceName: raw.deviceName,
        applianceId: raw.applianceId,
        applianceType: raw.applianceType,
        fwVersion: raw.fwVersion,
        deviceTypeVersion: raw.deviceTypeVersion,
        connectionSource: raw.connectionSource,
        deviceStatus: raw.deviceStatus,
        isFaren: raw.isFaren,
        latestAction: raw.latestAction,
        latEnv: raw.latEnv ?? { temp: 0, humidity: 0 },
        appliance,
        myRuleConfiguration: raw.myRuleConfiguration ?? {},
        confirmedPower: existing?.confirmedPower ?? raw.latestAction.power,
      };
      this.devices.set(mac, device);
      this.log.info('Raw device from Cielo REST API: %s', JSON.stringify({ ...raw, appliance }));
    }
  }

  private async restHeaders(): Promise<Record<string, string>> {
    return {
      'content-type': 'application/json; charset=UTF-8',
      referer: URL_CIELO,
      origin: URL_CIELO,
      'user-agent': WEB_USER_AGENT,
      host: URL_API,
      authorization: this.accessToken,
      'x-api-key': WEB_X_API_KEY,
    };
  }

  private async getDevicesRest(): Promise<any[]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://${URL_API}/${URL_API_DEVICES}`, {
        headers: await this.restHeaders(),
      });
      if (res.status === 401 && attempt === 0) {
        await this.refreshToken();
        continue;
      }
      if (!res.ok) {
        throw new Error(`Cielo device list failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as any;
      if (body.status !== 200 || body.message !== 'SUCCESS') {
        throw new Error(`Cielo device list failed: ${body.message}`);
      }
      return body.data.listDevices;
    }
    throw new Error('Cielo device list failed: unauthorized');
  }

  private async getApplianceInfoRest(applianceIds: string[]): Promise<any[]> {
    const res = await fetch(
      `https://${URL_API}/${URL_API_APPLIANCE_INFO}?applianceIdList=[${applianceIds.join(',')}]`,
      { headers: await this.restHeaders() },
    );
    if (!res.ok) {
      throw new Error(`Cielo appliance info failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as any;
    if (body.status !== 200 || body.message !== 'SUCCESS') {
      throw new Error(`Cielo appliance info failed: ${body.message}`);
    }
    return body.data.listAppliances;
  }

  // ---------------------------------------------------------------------
  // WebSocket (live control + state push)
  // ---------------------------------------------------------------------

  private connectWebSocket(): void {
    this.wsIntentionalClose = false;
    const wsUri = `wss://${URL_API_WSS}/websocket/?sessionId=${encodeURIComponent(
      this.sessionId,
    )}&token=${encodeURIComponent(this.accessToken)}`;

    this.ws = new WebSocket(wsUri, {
      headers: {
        Host: URL_API_WSS,
        'Cache-control': 'no-cache',
        Pragma: 'no-cache',
        'User-agent': WEB_USER_AGENT,
        Origin: URL_CIELO.slice(0, -1),
      },
    });

    this.ws.on('open', () => {
      this.log.info('Connected to Cielo cloud');
      this.reconnectAttempts = 0;
      this.lastMessageAtMs = Date.now();
      this.startHeartbeat();
    });

    this.ws.on('message', (data) => {
      this.lastMessageAtMs = Date.now();
      this.log.info('Cielo websocket <- %s', data.toString());
      this.handleMessage(data.toString());
    });

    this.ws.on('close', (code, reason) => {
      this.log.info('Disconnected from Cielo cloud (code %s%s)', code, reason ? `: ${reason}` : '');
      this.handleDisconnect();
    });
    this.ws.on('error', (err) => {
      this.log.warn('Cielo websocket error: %s', err);
    });
  }

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);

    this.pingTimer = setInterval(() => {
      this.ws?.send('ping');
    }, TIMER_PING_SEC * 1000);

    // If nothing at all comes back from the cloud for a full ping interval
    // plus a grace period, treat the connection as dead and reconnect.
    this.watchdogTimer = setInterval(() => {
      const idleMs = Date.now() - this.lastMessageAtMs;
      if (idleMs > (TIMER_PING_SEC + TIMER_PONG_TIMEOUT_SEC) * 1000) {
        this.log.warn('Cielo websocket looks dead, reconnecting');
        this.ws?.terminate();
      }
    }, 30_000);
  }

  private handleDisconnect(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.wsIntentionalClose) {
      return;
    }

    this.reconnectAttempts += 1;
    const delaySec = Math.min(
      RECONNECT_BASE_DELAY_SEC * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_SEC,
    );
    this.log.info('Reconnecting to Cielo cloud in %ss (attempt %s)', delaySec, this.reconnectAttempts);
    setTimeout(() => this.connectWebSocket(), delaySec * 1000);
  }

  private handleMessage(raw: string): void {
    if (raw === 'pong') {
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.message_type === 'StateUpdate') {
      const device = this.devices.get(normalizeMac(String(msg.mac_address)));
      if (!device) {
        this.log.debug('StateUpdate for unknown device %s, ignoring', msg.mac_address);
        return;
      }

      device.latEnv.temp = msg.lat_env_var?.temperature ?? device.latEnv.temp;
      device.latEnv.humidity = msg.lat_env_var?.humidity ?? device.latEnv.humidity;
      device.deviceStatus =
        msg.device_status === 0 && msg.action?.device_status === 'on' ? 1 : msg.device_status;

      const action = msg.action ?? {};
      device.latestAction = {
        ...device.latestAction,
        temp: action.temp ?? device.latestAction.temp,
        fanspeed: action.fanspeed ?? device.latestAction.fanspeed,
        mode: action.mode ?? device.latestAction.mode,
        power: action.power ?? device.latestAction.power,
        swing: action.swing ?? device.latestAction.swing,
        turbo: action.turbo ?? device.latestAction.turbo,
        light: action.light ?? device.latestAction.light,
        followme: action.followme ?? device.latestAction.followme,
      };
      device.confirmedPower = device.latestAction.power;

      this.log.info(
        '[%s] State update from Cielo: power=%s mode=%s fanspeed=%s temp=%s current=%s',
        device.deviceName,
        device.latestAction.power,
        device.latestAction.mode,
        device.latestAction.fanspeed,
        device.latestAction.temp,
        device.latEnv.temp,
      );

      this.emit('state-update', device);
    }
  }

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  private nextTs(): number {
    let ts = nowSec();
    if (ts === this.lastSentTsSec) {
      ts += 1;
    }
    this.lastSentTsSec = ts;
    return ts;
  }

  private buildBaseMsg(device: CieloDevice, action: string): Record<string, unknown> {
    return {
      action,
      actionSource: 'WEB',
      macAddress: device.rawMacAddress,
      user_id: this.userId,
      fw_version: device.fwVersion,
      deviceTypeVersion: device.deviceTypeVersion,
      mid: 'WEB',
      // Hardcoded to 0 rather than echoing device.connectionSource (which is
      // 1 for this device). Confirmed via direct testing: connection_source:1
      // gets accepted with no error but never relayed to the physical unit
      // (no "exe" ack, no device change); connection_source:0 gets a
      // "exe": "1" ack and the unit actually responds. Matches what the
      // actively-maintained node-smartcielo-ws client sends.
      connection_source: 0,
      application_version: '1.4.4',
      ts: this.nextTs(),
    };
  }

  private currentActionSnapshot(device: CieloDevice): Record<string, unknown> {
    const a = device.latestAction;
    // Preserving actual current state (not hardcoded) is confirmed fine -
    // connection_source:0 and the correctly-cased macAddress were the real
    // fixes for command relay, not fixed/dummy action values.
    const snapshot: Record<string, unknown> = {
      power: a.power,
      mode: a.mode,
      fanspeed: a.fanspeed,
      temp: a.temp,
      swing: a.swing,
      swinginternal: '',
    };
    if (a.turbo !== undefined) snapshot.turbo = a.turbo;
    if (a.light !== undefined) snapshot.light = a.light === 'on/off' ? 'off' : a.light;
    if (a.followme !== undefined) snapshot.followme = a.followme;
    return snapshot;
  }

  private send(device: CieloDevice, changes: Record<string, unknown>, actionType: ActionType, actionValue: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log.warn('Cannot send command: not connected to Cielo cloud');
      return;
    }

    const oldPower = device.confirmedPower;
    const action = { ...this.currentActionSnapshot(device), ...changes };
    Object.assign(device.latestAction, changes);

    const msg = {
      ...this.buildBaseMsg(device, 'actionControl'),
      fwVersion: device.fwVersion,
      applianceType: device.applianceType,
      applianceId: device.applianceId,
      myRuleConfiguration: device.myRuleConfiguration ?? {},
      preset: 0,
      actions: action,
      oldPower,
      actionType,
      actionValue,
    };

    const raw = JSON.stringify(msg);
    this.log.info('Cielo websocket -> %s', raw);
    this.ws.send(raw);
  }

  setPower(device: CieloDevice, on: boolean): void {
    const value = on ? 'on' : 'off';
    this.log.info('[%s] setPower(%s) requested (currently %s)', device.deviceName, value, device.latestAction.power);
    if (device.latestAction.power === value) {
      this.log.info('[%s] setPower: already %s, skipping', device.deviceName, value);
      return;
    }
    this.send(device, { power: value }, 'power', value);
  }

  /** cool | heat | auto | dry | fan */
  setMode(device: CieloDevice, mode: string): void {
    this.log.info('[%s] setMode(%s) requested (currently %s)', device.deviceName, mode, device.latestAction.mode);
    let value = mode;
    if (mode === 'cool' && device.appliance.mode === 'mode') {
      // Some single-mode appliances report their only mode as literally "mode".
      value = 'mode';
    }

    const needsPowerOn = device.latestAction.power === 'off';
    if (!needsPowerOn && device.latestAction.mode === value) {
      this.log.info('[%s] setMode: already %s, skipping', device.deviceName, value);
      return;
    }

    // Power-on and mode change must go in the SAME command, not two
    // sequential ones. Sending them separately (power-on first, using
    // whatever mode was last cached, then a follow-up mode-change command)
    // creates a real window where the device receives "on" with the stale
    // mode before the correction arrives - e.g. turning the unit back on
    // after it was last in Dry very briefly re-engages Dry before flipping
    // to the newly requested mode.
    const changes: Record<string, unknown> = { mode: value };
    if (needsPowerOn) {
      changes.power = 'on';
    }
    this.send(device, changes, 'mode', value);
  }

  /** auto | low | medium | high */
  setFanSpeed(device: CieloDevice, speed: string): void {
    this.log.info(
      '[%s] setFanSpeed(%s) requested (currently %s)',
      device.deviceName,
      speed,
      device.latestAction.fanspeed,
    );
    if (device.latestAction.fanspeed === speed) {
      this.log.info('[%s] setFanSpeed: already %s, skipping', device.deviceName, speed);
      return;
    }
    this.send(device, { fanspeed: speed }, 'fanspeed', speed);
  }

  supportsSwing(device: CieloDevice): boolean {
    return !!device.appliance.swing && device.appliance.swing.trim() !== '';
  }

  /** Any raw swing value the appliance supports, e.g. auto | pos1 | pos2 | pos3 | adjust | auto/stop */
  setSwing(device: CieloDevice, swing: string): void {
    this.log.info('[%s] setSwing(%s) requested (currently %s)', device.deviceName, swing, device.latestAction.swing);
    if (device.latestAction.swing === swing) {
      this.log.info('[%s] setSwing: already %s, skipping', device.deviceName, swing);
      return;
    }
    this.send(device, { swing }, 'swing', swing);
  }

  supportsTargetTemperature(device: CieloDevice): boolean {
    return device.appliance.temp !== 'inc:dec';
  }

  /** Target temperature in the appliance's own unit (F or C, matching device.appliance.isFaren). */
  setTemperature(device: CieloDevice, targetDeviceUnitTemp: number): void {
    const current = parseInt(device.latestAction.temp, 10);
    this.log.info(
      '[%s] setTemperature(%s) requested (currently %s, supportsTargetTemp=%s)',
      device.deviceName,
      targetDeviceUnitTemp,
      current,
      this.supportsTargetTemperature(device),
    );

    if (current === targetDeviceUnitTemp && this.supportsTargetTemperature(device)) {
      this.log.info('[%s] setTemperature: already %s, skipping', device.deviceName, targetDeviceUnitTemp);
      return;
    }

    if (!this.supportsTargetTemperature(device)) {
      // Appliance only supports single-step inc/dec nudges.
      const increasing = current < targetDeviceUnitTemp;
      const value = increasing ? current + 1 : current - 1;
      this.send(device, { temp: String(value) }, 'temp', increasing ? 'inc' : 'dec');
      return;
    }

    this.send(device, { temp: String(targetDeviceUnitTemp) }, 'temp', String(targetDeviceUnitTemp));
  }
}

export function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/[^0-9a-f]/g, '');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function formatTzOffset(): string {
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}
