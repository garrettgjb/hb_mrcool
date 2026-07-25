"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CieloApi = void 0;
exports.normalizeMac = normalizeMac;
const events_1 = require("events");
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const ws_1 = __importDefault(require("ws"));
const settings_1 = require("./settings");
class CieloApi extends events_1.EventEmitter {
    constructor(log, email, password, tokenStoragePath) {
        super();
        this.log = log;
        this.email = email;
        this.password = password;
        this.tokenStoragePath = tokenStoragePath;
        this.accessToken = '';
        this.refreshTokenValue = '';
        this.sessionId = '';
        this.userId = '';
        this.tokenExpireAtSec = 0;
        this.devices = new Map();
        this.ws = null;
        this.wsIntentionalClose = false;
        this.reconnectAttempts = 0;
        this.pingTimer = null;
        this.watchdogTimer = null;
        this.tokenCheckTimer = null;
        this.lastMessageAtMs = 0;
        this.lastSentTsSec = 0;
    }
    async start() {
        if (!(await this.tryPersistedTokens())) {
            await this.login();
        }
        await this.refreshDeviceList();
        this.connectWebSocket();
        this.tokenCheckTimer = setInterval(() => this.checkTokenExpiry(), 60000);
    }
    stop() {
        this.wsIntentionalClose = true;
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        if (this.watchdogTimer)
            clearInterval(this.watchdogTimer);
        if (this.tokenCheckTimer)
            clearInterval(this.tokenCheckTimer);
        this.ws?.close();
    }
    getDevice(macAddress) {
        return this.devices.get(normalizeMac(macAddress));
    }
    getAllDevices() {
        return Array.from(this.devices.values());
    }
    // ---------------------------------------------------------------------
    // Auth
    // ---------------------------------------------------------------------
    async tryPersistedTokens() {
        try {
            const raw = fs.readFileSync(this.tokenStoragePath, 'utf-8');
            const tokens = JSON.parse(raw);
            this.applyTokens(tokens);
            // Confirm the persisted tokens are actually still valid before relying
            // on them for the rest of startup.
            const ok = await this.refreshToken();
            return ok;
        }
        catch {
            return false;
        }
    }
    applyTokens(tokens) {
        this.accessToken = tokens.accessToken;
        this.refreshTokenValue = tokens.refreshToken;
        this.sessionId = tokens.sessionId;
        this.userId = tokens.userId;
        this.tokenExpireAtSec = nowSec() + settings_1.TIME_REFRESH_TOKEN_SEC;
    }
    persistTokens() {
        const bundle = {
            accessToken: this.accessToken,
            refreshToken: this.refreshTokenValue,
            sessionId: this.sessionId,
            userId: this.userId,
        };
        try {
            fs.writeFileSync(this.tokenStoragePath, JSON.stringify(bundle), { mode: 0o600 });
        }
        catch (err) {
            this.log.warn('Could not persist Cielo tokens to disk: %s', err);
        }
    }
    // Logs in via the mobile app's endpoint. Unlike the web login used by
    // home.cielowigle.com, this one is not behind a CAPTCHA.
    async login() {
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
        const res = await fetch(`https://${settings_1.URL_API}/${settings_1.URL_API_LOGIN}`, {
            method: 'POST',
            headers: {
                accept: '*/*',
                'content-type': 'application/json',
                'x-api-key': settings_1.IOS_X_API_KEY,
                'user-agent': settings_1.IOS_USER_AGENT,
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            throw new Error(`Cielo login failed: HTTP ${res.status}`);
        }
        const body = (await res.json());
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
    async refreshToken() {
        try {
            const res = await fetch(`https://${settings_1.URL_API}/${settings_1.URL_API_REFRESH}`, {
                method: 'POST',
                headers: {
                    accept: '*/*',
                    'content-type': 'application/json',
                    'x-api-key': settings_1.IOS_X_API_KEY,
                    'user-agent': settings_1.IOS_USER_AGENT,
                    authorization: this.accessToken,
                },
                body: JSON.stringify({ refreshToken: this.refreshTokenValue }),
            });
            if (!res.ok) {
                this.log.warn('Cielo token refresh failed: HTTP %s', res.status);
                return false;
            }
            const body = (await res.json());
            if (body.status !== 200 || body.message !== 'SUCCESS') {
                this.log.warn('Cielo token refresh failed: %s', body.message);
                return false;
            }
            this.accessToken = body.data.accessToken;
            this.refreshTokenValue = body.data.refreshToken;
            this.tokenExpireAtSec = nowSec() + settings_1.TIME_REFRESH_TOKEN_SEC;
            this.persistTokens();
            return true;
        }
        catch (err) {
            this.log.warn('Cielo token refresh error: %s', err);
            return false;
        }
    }
    checkTokenExpiry() {
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
    async refreshDeviceList() {
        const devices = await this.getDevicesRest();
        const applianceIds = Array.from(new Set(devices.map((d) => String(d.applianceId)).filter((id) => id && id !== '0')));
        const appliances = applianceIds.length ? await this.getApplianceInfoRest(applianceIds) : [];
        for (const raw of devices) {
            const applianceId = String(raw.applianceId);
            if (!applianceId || applianceId === '0') {
                this.log.warn("Device '%s' has no supported appliance, skipping", raw.deviceName);
                continue;
            }
            const appliance = appliances.find((a) => String(a.applianceId) === applianceId);
            if (!appliance) {
                this.log.warn('No appliance data found for device %s', raw.deviceName);
                continue;
            }
            const mac = normalizeMac(raw.macAddress);
            const existing = this.devices.get(mac);
            const device = {
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
    async restHeaders() {
        return {
            'content-type': 'application/json; charset=UTF-8',
            referer: settings_1.URL_CIELO,
            origin: settings_1.URL_CIELO,
            'user-agent': settings_1.WEB_USER_AGENT,
            host: settings_1.URL_API,
            authorization: this.accessToken,
            'x-api-key': settings_1.WEB_X_API_KEY,
        };
    }
    async getDevicesRest() {
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await fetch(`https://${settings_1.URL_API}/${settings_1.URL_API_DEVICES}`, {
                headers: await this.restHeaders(),
            });
            if (res.status === 401 && attempt === 0) {
                await this.refreshToken();
                continue;
            }
            if (!res.ok) {
                throw new Error(`Cielo device list failed: HTTP ${res.status}`);
            }
            const body = (await res.json());
            if (body.status !== 200 || body.message !== 'SUCCESS') {
                throw new Error(`Cielo device list failed: ${body.message}`);
            }
            return body.data.listDevices;
        }
        throw new Error('Cielo device list failed: unauthorized');
    }
    async getApplianceInfoRest(applianceIds) {
        const res = await fetch(`https://${settings_1.URL_API}/${settings_1.URL_API_APPLIANCE_INFO}?applianceIdList=[${applianceIds.join(',')}]`, { headers: await this.restHeaders() });
        if (!res.ok) {
            throw new Error(`Cielo appliance info failed: HTTP ${res.status}`);
        }
        const body = (await res.json());
        if (body.status !== 200 || body.message !== 'SUCCESS') {
            throw new Error(`Cielo appliance info failed: ${body.message}`);
        }
        return body.data.listAppliances;
    }
    // ---------------------------------------------------------------------
    // WebSocket (live control + state push)
    // ---------------------------------------------------------------------
    connectWebSocket() {
        this.wsIntentionalClose = false;
        const wsUri = `wss://${settings_1.URL_API_WSS}/websocket/?sessionId=${encodeURIComponent(this.sessionId)}&token=${encodeURIComponent(this.accessToken)}`;
        this.ws = new ws_1.default(wsUri, {
            headers: {
                Host: settings_1.URL_API_WSS,
                'Cache-control': 'no-cache',
                Pragma: 'no-cache',
                'User-agent': settings_1.WEB_USER_AGENT,
                Origin: settings_1.URL_CIELO.slice(0, -1),
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
    startHeartbeat() {
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        if (this.watchdogTimer)
            clearInterval(this.watchdogTimer);
        this.pingTimer = setInterval(() => {
            this.ws?.send('ping');
        }, settings_1.TIMER_PING_SEC * 1000);
        // If nothing at all comes back from the cloud for a full ping interval
        // plus a grace period, treat the connection as dead and reconnect.
        this.watchdogTimer = setInterval(() => {
            const idleMs = Date.now() - this.lastMessageAtMs;
            if (idleMs > (settings_1.TIMER_PING_SEC + settings_1.TIMER_PONG_TIMEOUT_SEC) * 1000) {
                this.log.warn('Cielo websocket looks dead, reconnecting');
                this.ws?.terminate();
            }
        }, 30000);
    }
    handleDisconnect() {
        if (this.pingTimer)
            clearInterval(this.pingTimer);
        if (this.watchdogTimer)
            clearInterval(this.watchdogTimer);
        if (this.wsIntentionalClose) {
            return;
        }
        this.reconnectAttempts += 1;
        const delaySec = Math.min(settings_1.RECONNECT_BASE_DELAY_SEC * 2 ** (this.reconnectAttempts - 1), settings_1.RECONNECT_MAX_DELAY_SEC);
        this.log.info('Reconnecting to Cielo cloud in %ss (attempt %s)', delaySec, this.reconnectAttempts);
        setTimeout(() => this.connectWebSocket(), delaySec * 1000);
    }
    handleMessage(raw) {
        if (raw === 'pong') {
            return;
        }
        let msg;
        try {
            msg = JSON.parse(raw);
        }
        catch {
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
            this.log.info('[%s] State update from Cielo: power=%s mode=%s fanspeed=%s temp=%s current=%s', device.deviceName, device.latestAction.power, device.latestAction.mode, device.latestAction.fanspeed, device.latestAction.temp, device.latEnv.temp);
            this.emit('state-update', device);
        }
    }
    // ---------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------
    nextTs() {
        let ts = nowSec();
        if (ts === this.lastSentTsSec) {
            ts += 1;
        }
        this.lastSentTsSec = ts;
        return ts;
    }
    buildBaseMsg(device, action) {
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
    currentActionSnapshot(device) {
        const a = device.latestAction;
        // Preserving actual current state (not hardcoded) is confirmed fine -
        // connection_source:0 and the correctly-cased macAddress were the real
        // fixes for command relay, not fixed/dummy action values.
        const snapshot = {
            power: a.power,
            mode: a.mode,
            fanspeed: a.fanspeed,
            temp: a.temp,
            swing: a.swing,
            swinginternal: '',
        };
        if (a.turbo !== undefined)
            snapshot.turbo = a.turbo;
        if (a.light !== undefined)
            snapshot.light = a.light === 'on/off' ? 'off' : a.light;
        if (a.followme !== undefined)
            snapshot.followme = a.followme;
        return snapshot;
    }
    send(device, changes, actionType, actionValue) {
        if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
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
    setPower(device, on) {
        const value = on ? 'on' : 'off';
        this.log.info('[%s] setPower(%s) requested (currently %s)', device.deviceName, value, device.latestAction.power);
        if (device.latestAction.power === value) {
            this.log.info('[%s] setPower: already %s, skipping', device.deviceName, value);
            return;
        }
        this.send(device, { power: value }, 'power', value);
    }
    /** cool | heat | auto | dry | fan */
    setMode(device, mode) {
        this.log.info('[%s] setMode(%s) requested (currently %s)', device.deviceName, mode, device.latestAction.mode);
        if (device.latestAction.power === 'off') {
            this.setPower(device, true);
        }
        let value = mode;
        if (mode === 'cool' && device.appliance.mode === 'mode') {
            // Some single-mode appliances report their only mode as literally "mode".
            value = 'mode';
        }
        if (device.latestAction.mode === value) {
            this.log.info('[%s] setMode: already %s, skipping', device.deviceName, value);
            return;
        }
        this.send(device, { mode: value }, 'mode', value);
    }
    /** auto | low | medium | high */
    setFanSpeed(device, speed) {
        this.log.info('[%s] setFanSpeed(%s) requested (currently %s)', device.deviceName, speed, device.latestAction.fanspeed);
        if (device.latestAction.fanspeed === speed) {
            this.log.info('[%s] setFanSpeed: already %s, skipping', device.deviceName, speed);
            return;
        }
        this.send(device, { fanspeed: speed }, 'fanspeed', speed);
    }
    supportsSwing(device) {
        return !!device.appliance.swing && device.appliance.swing.trim() !== '';
    }
    /** Any raw swing value the appliance supports, e.g. auto | pos1 | pos2 | pos3 | adjust | auto/stop */
    setSwing(device, swing) {
        this.log.info('[%s] setSwing(%s) requested (currently %s)', device.deviceName, swing, device.latestAction.swing);
        if (device.latestAction.swing === swing) {
            this.log.info('[%s] setSwing: already %s, skipping', device.deviceName, swing);
            return;
        }
        this.send(device, { swing }, 'swing', swing);
    }
    supportsTargetTemperature(device) {
        return device.appliance.temp !== 'inc:dec';
    }
    /** Target temperature in the appliance's own unit (F or C, matching device.appliance.isFaren). */
    setTemperature(device, targetDeviceUnitTemp) {
        const current = parseInt(device.latestAction.temp, 10);
        this.log.info('[%s] setTemperature(%s) requested (currently %s, supportsTargetTemp=%s)', device.deviceName, targetDeviceUnitTemp, current, this.supportsTargetTemperature(device));
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
exports.CieloApi = CieloApi;
function normalizeMac(mac) {
    return mac.toLowerCase().replace(/[^0-9a-f]/g, '');
}
function nowSec() {
    return Math.floor(Date.now() / 1000);
}
function formatTzOffset() {
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${sign}${hh}:${mm}`;
}
//# sourceMappingURL=cieloApi.js.map