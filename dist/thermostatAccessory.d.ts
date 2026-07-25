import type { PlatformAccessory } from 'homebridge';
import type { MrCoolCieloPlatform } from './platform';
import type { CieloApi, CieloDevice } from './cieloApi';
export declare class ThermostatAccessory {
    private readonly platform;
    private readonly accessory;
    private readonly cielo;
    private readonly displayName;
    private readonly exposeDryMode;
    private heaterCoolerService;
    private dryModeSwitch?;
    private supportsFanSpeed;
    private supportsSwing;
    private device;
    constructor(platform: MrCoolCieloPlatform, accessory: PlatformAccessory, cielo: CieloApi, initialDevice: CieloDevice, displayName: string, exposeDryMode: boolean);
    /** Called by the platform whenever a StateUpdate arrives for this device's MAC. */
    updateFromDevice(device: CieloDevice): void;
    private getActive;
    private setActive;
    private getCurrentState;
    private getTargetState;
    private setTargetState;
    private isDeviceFahrenheit;
    private temperatureProps;
    private getCurrentTemperature;
    private getTargetTemperature;
    private setTargetTemperature;
    private getRotationSpeed;
    private setRotationSpeed;
    private swingOptions;
    /** The fixed (non-oscillating) swing position used when swing is disabled. */
    private swingOffValue;
    private getSwingMode;
    private setSwingMode;
}
