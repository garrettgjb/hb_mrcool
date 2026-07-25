import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';
import * as path from 'path';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { CieloApi, CieloDevice, normalizeMac } from './cieloApi';
import { ThermostatAccessory } from './thermostatAccessory';

interface MrCoolCieloConfig extends PlatformConfig {
  email: string;
  password: string;
  macAddress?: string;
}

export class MrCoolCieloPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  private readonly cachedAccessories: PlatformAccessory[] = [];
  private readonly thermostats = new Map<string, ThermostatAccessory>();
  private cielo?: CieloApi;

  constructor(
    public readonly log: Logging,
    public readonly config: MrCoolCieloConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    if (!config.email || !config.password) {
      this.log.error('MrCoolCielo platform is missing "email" or "password" in config, not starting');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.startCielo(config).catch((err) => {
        this.log.error('Failed to start Cielo integration: %s', err);
      });
    });
  }

  /** Homebridge calls this for every cached accessory before didFinishLaunching. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  private async startCielo(config: MrCoolCieloConfig): Promise<void> {
    const tokenStoragePath = path.join(this.api.user.storagePath(), 'mrcool-cielo-tokens.json');
    this.cielo = new CieloApi(this.log, config.email, config.password, tokenStoragePath);

    this.cielo.on('state-update', (device: CieloDevice) => {
      const thermostat = this.thermostats.get(device.macAddress);
      thermostat?.updateFromDevice(device);
    });

    await this.cielo.start();

    const devices = this.cielo.getAllDevices();
    if (devices.length === 0) {
      this.log.error('Cielo account returned no controllable devices');
      return;
    }

    // With a macAddress configured, register just that one device.
    if (config.macAddress) {
      const wanted = normalizeMac(config.macAddress);
      const match = devices.find((d) => d.macAddress === wanted);
      if (!match) {
        this.log.error(
          'Configured macAddress %s not found. Available devices: %s',
          config.macAddress,
          devices.map((d) => `${d.deviceName} (${d.macAddress})`).join(', '),
        );
        return;
      }
      this.registerDevice(match);
      return;
    }

    // Otherwise auto-register every device found on the account.
    this.log.info(
      'No macAddress configured - auto-registering all %s device(s) found on the account: %s',
      devices.length,
      devices.map((d) => `${d.deviceName} (${d.macAddress})`).join(', '),
    );
    for (const device of devices) {
      this.registerDevice(device);
    }
  }

  private registerDevice(device: CieloDevice): void {
    const uuid = this.api.hap.uuid.generate(device.macAddress);
    let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);

    if (accessory) {
      this.log.info('Restoring cached accessory for %s', device.deviceName);
      accessory.context.device = device;
      this.api.updatePlatformAccessories([accessory]);
    } else {
      this.log.info('Registering new accessory for %s', device.deviceName);
      accessory = new this.api.platformAccessory(device.deviceName, uuid);
      accessory.context.device = device;
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    const thermostat = new ThermostatAccessory(this, accessory, this.cielo!, device, device.deviceName);
    this.thermostats.set(device.macAddress, thermostat);
  }
}
