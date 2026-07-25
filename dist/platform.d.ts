import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
interface MrCoolCieloConfig extends PlatformConfig {
    email: string;
    password: string;
    macAddress?: string;
}
export declare class MrCoolCieloPlatform implements DynamicPlatformPlugin {
    readonly log: Logging;
    readonly config: MrCoolCieloConfig;
    readonly api: API;
    readonly Service: typeof Service;
    readonly Characteristic: typeof Characteristic;
    private readonly cachedAccessories;
    private readonly thermostats;
    private cielo?;
    constructor(log: Logging, config: MrCoolCieloConfig, api: API);
    /** Homebridge calls this for every cached accessory before didFinishLaunching. */
    configureAccessory(accessory: PlatformAccessory): void;
    private startCielo;
    private registerDevice;
}
export {};
