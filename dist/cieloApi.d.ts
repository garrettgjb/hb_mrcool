import { EventEmitter } from 'events';
import type { Logging } from 'homebridge';
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
    mode: string;
    fan: string;
    swing?: string;
    temp: string;
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
    latEnv: {
        temp: number;
        humidity: number;
    };
    appliance: CieloAppliance;
    myRuleConfiguration?: Record<string, unknown>;
    confirmedPower: string;
}
export declare class CieloApi extends EventEmitter {
    private readonly log;
    private readonly email;
    private readonly password;
    private readonly tokenStoragePath;
    private accessToken;
    private refreshTokenValue;
    private sessionId;
    private userId;
    private tokenExpireAtSec;
    private devices;
    private ws;
    private wsIntentionalClose;
    private reconnectAttempts;
    private pingTimer;
    private watchdogTimer;
    private tokenCheckTimer;
    private lastMessageAtMs;
    private lastSentTsSec;
    constructor(log: Logging, email: string, password: string, tokenStoragePath: string);
    start(): Promise<void>;
    stop(): void;
    getDevice(macAddress: string): CieloDevice | undefined;
    getAllDevices(): CieloDevice[];
    private tryPersistedTokens;
    private applyTokens;
    private persistTokens;
    private login;
    private refreshToken;
    private checkTokenExpiry;
    refreshDeviceList(): Promise<void>;
    private restHeaders;
    private getDevicesRest;
    private getApplianceInfoRest;
    private connectWebSocket;
    private startHeartbeat;
    private handleDisconnect;
    private handleMessage;
    private nextTs;
    private buildBaseMsg;
    private currentActionSnapshot;
    private send;
    setPower(device: CieloDevice, on: boolean): void;
    /** cool | heat | auto | dry | fan */
    setMode(device: CieloDevice, mode: string): void;
    /** auto | low | medium | high */
    setFanSpeed(device: CieloDevice, speed: string): void;
    supportsSwing(device: CieloDevice): boolean;
    /** Any raw swing value the appliance supports, e.g. auto | pos1 | pos2 | pos3 | adjust | auto/stop */
    setSwing(device: CieloDevice, swing: string): void;
    supportsTargetTemperature(device: CieloDevice): boolean;
    /** Target temperature in the appliance's own unit (F or C, matching device.appliance.isFaren). */
    setTemperature(device: CieloDevice, targetDeviceUnitTemp: number): void;
}
export declare function normalizeMac(mac: string): string;
