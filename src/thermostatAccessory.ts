import type { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import type { MrCoolCieloPlatform } from './platform';
import type { CieloApi, CieloDevice } from './cieloApi';

// Ordered low -> high so percentage buckets read naturally (higher % = more
// airflow). "auto" occupies the lowest band rather than 0%, since HomeKit
// treats 0% on a fan/rotation-speed characteristic as equivalent to off.
const FAN_SPEED_ORDER = ['auto', 'low', 'medium', 'high'];

export class ThermostatAccessory {
  private heaterCoolerService: Service;
  private dryModeSwitch?: Service;
  private supportsFanSpeed: boolean;
  private supportsSwing: boolean;

  private device: CieloDevice;

  constructor(
    private readonly platform: MrCoolCieloPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly cielo: CieloApi,
    initialDevice: CieloDevice,
    private readonly displayName: string,
    private readonly exposeDryMode: boolean,
  ) {
    this.device = initialDevice;
    const { Service, Characteristic } = this.platform;
    this.supportsFanSpeed = !!this.device.appliance.fan && this.device.appliance.fan.trim() !== '';
    this.supportsSwing = this.cielo.supportsSwing(this.device);

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'MrCool / Cielo')
      .setCharacteristic(Characteristic.Model, this.device.applianceType || 'Breez-i')
      .setCharacteristic(Characteristic.SerialNumber, this.device.macAddress);

    this.heaterCoolerService =
      this.accessory.getService(Service.HeaterCooler) ||
      this.accessory.addService(Service.HeaterCooler, this.displayName);
    this.heaterCoolerService.setPrimaryService(true);
    this.heaterCoolerService.updateCharacteristic(Characteristic.Name, this.displayName);

    this.heaterCoolerService
      .getCharacteristic(Characteristic.Active)
      .onGet(() => this.getActive())
      .onSet((value) => this.setActive(value));

    this.heaterCoolerService
      .getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.getCurrentState());

    this.heaterCoolerService
      .getCharacteristic(Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          Characteristic.TargetHeaterCoolerState.AUTO,
          Characteristic.TargetHeaterCoolerState.HEAT,
          Characteristic.TargetHeaterCoolerState.COOL,
        ],
      })
      .onGet(() => this.getTargetState())
      .onSet((value) => this.setTargetState(value));

    this.heaterCoolerService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(() => this.getCurrentTemperature());

    const tempProps = this.temperatureProps();

    this.heaterCoolerService
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps(tempProps)
      .onGet(() => this.getTargetTemperature())
      .onSet((value) => this.setTargetTemperature(value));

    this.heaterCoolerService
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .setProps(tempProps)
      .onGet(() => this.getTargetTemperature())
      .onSet((value) => this.setTargetTemperature(value));

    if (this.supportsFanSpeed) {
      this.heaterCoolerService
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
        .onGet(() => this.getRotationSpeed())
        .onSet((value) => this.setRotationSpeed(value));
    }

    if (this.supportsSwing) {
      this.heaterCoolerService
        .getCharacteristic(Characteristic.SwingMode)
        .onGet(() => this.getSwingMode())
        .onSet((value) => this.setSwingMode(value));
    }

    const supportedModes = this.device.appliance.mode ? this.device.appliance.mode.split(':') : [];

    // Migration cleanup: fan-only mode used to be exposed as its own service
    // (first a Switch, briefly a Fanv2), both with subtype "fan-only". Not
    // exposed at all anymore - HomeKit's HeaterCooler has no fan-only target
    // state, and a bolted-on separate service for it was more confusing than
    // useful. Homebridge doesn't remove services that stop being added, so
    // clean up whichever of the two a previously-installed version left behind.
    for (const staleType of [Service.Switch, Service.Fanv2]) {
      const stale = this.accessory.getServiceById(staleType, 'fan-only');
      if (stale) {
        this.accessory.removeService(stale);
      }
    }

    if (supportedModes.includes('dry') && this.exposeDryMode) {
      this.dryModeSwitch =
        this.accessory.getServiceById(Service.Switch, 'dry-mode') ||
        this.accessory.addService(Service.Switch, `${this.displayName} Dry Mode`, 'dry-mode');
      this.dryModeSwitch
        .getCharacteristic(Characteristic.On)
        .onGet(() => this.device.latestAction.power === 'on' && this.device.latestAction.mode === 'dry')
        .onSet((value) => {
          if (value) {
            this.cielo.setMode(this.device, 'dry');
          } else if (this.device.latestAction.mode === 'dry') {
            this.cielo.setPower(this.device, false);
          }
        });
    } else {
      // Migration cleanup: remove a previously-registered Dry Mode switch if
      // exposeDryMode is now off (or was never explicitly turned on - this
      // defaults to off specifically so it can't be triggered by an
      // accidental tap or Siri misfire).
      const stale = this.accessory.getServiceById(Service.Switch, 'dry-mode');
      if (stale) {
        this.accessory.removeService(stale);
      }
    }
  }

  /** Called by the platform whenever a StateUpdate arrives for this device's MAC. */
  updateFromDevice(device: CieloDevice): void {
    this.device = device;
    const { Characteristic } = this.platform;

    this.heaterCoolerService.updateCharacteristic(Characteristic.Active, this.getActive());
    this.heaterCoolerService.updateCharacteristic(
      Characteristic.CurrentHeaterCoolerState,
      this.getCurrentState(),
    );
    this.heaterCoolerService.updateCharacteristic(
      Characteristic.TargetHeaterCoolerState,
      this.getTargetState(),
    );
    this.heaterCoolerService.updateCharacteristic(
      Characteristic.CurrentTemperature,
      this.getCurrentTemperature(),
    );
    this.heaterCoolerService.updateCharacteristic(
      Characteristic.CoolingThresholdTemperature,
      this.getTargetTemperature(),
    );
    this.heaterCoolerService.updateCharacteristic(
      Characteristic.HeatingThresholdTemperature,
      this.getTargetTemperature(),
    );

    if (this.supportsFanSpeed) {
      this.heaterCoolerService.updateCharacteristic(Characteristic.RotationSpeed, this.getRotationSpeed());
    }
    if (this.supportsSwing) {
      this.heaterCoolerService.updateCharacteristic(Characteristic.SwingMode, this.getSwingMode());
    }

    this.dryModeSwitch?.updateCharacteristic(
      Characteristic.On,
      device.latestAction.power === 'on' && device.latestAction.mode === 'dry',
    );
  }

  // -- Active / power ------------------------------------------------------

  private getActive(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.device.latestAction.power === 'on'
      ? Characteristic.Active.ACTIVE
      : Characteristic.Active.INACTIVE;
  }

  private setActive(value: CharacteristicValue): void {
    const { Characteristic } = this.platform;
    this.platform.log.info('[%s] HomeKit requested Active=%s', this.displayName, value);
    // Cielo's actionControl always echoes the currently cached mode/temp/fan
    // alongside a power change, so turning back on naturally resumes the
    // last operating mode rather than requiring an explicit "default mode".
    this.cielo.setPower(this.device, value === Characteristic.Active.ACTIVE);
  }

  // -- Mode ------------------------------------------------------------------

  private getCurrentState(): CharacteristicValue {
    const { Characteristic } = this.platform;
    if (this.device.latestAction.power !== 'on') {
      return Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }
    switch (this.device.latestAction.mode) {
      case 'heat':
        return Characteristic.CurrentHeaterCoolerState.HEATING;
      case 'cool':
      case 'mode':
        return Characteristic.CurrentHeaterCoolerState.COOLING;
      default:
        return Characteristic.CurrentHeaterCoolerState.IDLE;
    }
  }

  private getTargetState(): CharacteristicValue {
    const { Characteristic } = this.platform;
    switch (this.device.latestAction.mode) {
      case 'heat':
        return Characteristic.TargetHeaterCoolerState.HEAT;
      case 'cool':
      case 'mode':
        return Characteristic.TargetHeaterCoolerState.COOL;
      default:
        return Characteristic.TargetHeaterCoolerState.AUTO;
    }
  }

  private setTargetState(value: CharacteristicValue): void {
    const { Characteristic } = this.platform;
    this.platform.log.info('[%s] HomeKit requested TargetHeaterCoolerState=%s', this.displayName, value);
    if (value === Characteristic.TargetHeaterCoolerState.HEAT) {
      this.cielo.setMode(this.device, 'heat');
    } else if (value === Characteristic.TargetHeaterCoolerState.COOL) {
      this.cielo.setMode(this.device, 'cool');
    } else {
      this.cielo.setMode(this.device, 'auto');
    }
  }

  // -- Temperature -------------------------------------------------------

  private isDeviceFahrenheit(): boolean {
    return this.device.appliance.isFaren === 1;
  }

  private temperatureProps(): { minValue: number; maxValue: number; minStep: number } {
    const [minRaw, maxRaw] = (this.device.appliance.temp || '60:86').split(':').map(Number);
    if (Number.isNaN(minRaw) || Number.isNaN(maxRaw)) {
      return { minValue: 16, maxValue: 30, minStep: 0.5 };
    }
    const min = this.isDeviceFahrenheit() ? fahrenheitToCelsius(minRaw) : minRaw;
    const max = this.isDeviceFahrenheit() ? fahrenheitToCelsius(maxRaw) : maxRaw;
    return { minValue: Math.min(min, max), maxValue: Math.max(min, max), minStep: 0.5 };
  }

  private getCurrentTemperature(): CharacteristicValue {
    const raw = this.device.latEnv.temp || 0;
    return this.isDeviceFahrenheit() ? fahrenheitToCelsius(raw) : raw;
  }

  private getTargetTemperature(): CharacteristicValue {
    const raw = parseInt(this.device.latestAction.temp, 10) || 0;
    return this.isDeviceFahrenheit() ? fahrenheitToCelsius(raw) : raw;
  }

  private setTargetTemperature(value: CharacteristicValue): void {
    const celsius = value as number;
    const deviceUnitTemp = this.isDeviceFahrenheit()
      ? Math.round(celsiusToFahrenheit(celsius))
      : Math.round(celsius);
    this.platform.log.info(
      '[%s] HomeKit requested target temperature %s°C -> %s%s',
      this.displayName,
      celsius,
      deviceUnitTemp,
      this.isDeviceFahrenheit() ? 'F' : 'C',
    );
    this.cielo.setTemperature(this.device, deviceUnitTemp);
  }

  // -- Fan speed -------------------------------------------------------------

  private getRotationSpeed(): CharacteristicValue {
    const idx = FAN_SPEED_ORDER.indexOf(this.device.latestAction.fanspeed);
    return idx === -1 ? 25 : (idx + 1) * 25;
  }

  private setRotationSpeed(value: CharacteristicValue): void {
    const step = Math.min(4, Math.max(1, Math.ceil((value as number) / 25)));
    const speed = FAN_SPEED_ORDER[step - 1];
    this.platform.log.info('[%s] HomeKit requested RotationSpeed=%s -> %s', this.displayName, value, speed);
    this.cielo.setFanSpeed(this.device, speed);
  }

  // -- Swing -------------------------------------------------------------

  private swingOptions(): string[] {
    return this.device.appliance.swing ? this.device.appliance.swing.split(':') : [];
  }

  /** The fixed (non-oscillating) swing position used when swing is disabled. */
  private swingOffValue(): string {
    const options = this.swingOptions();
    return options.find((o) => o !== 'auto' && o !== 'auto/stop') ?? options[0] ?? 'pos1';
  }

  private getSwingMode(): CharacteristicValue {
    const { Characteristic } = this.platform;
    return this.device.latestAction.swing === 'auto'
      ? Characteristic.SwingMode.SWING_ENABLED
      : Characteristic.SwingMode.SWING_DISABLED;
  }

  private setSwingMode(value: CharacteristicValue): void {
    const { Characteristic } = this.platform;
    const swing = value === Characteristic.SwingMode.SWING_ENABLED ? 'auto' : this.swingOffValue();
    this.platform.log.info('[%s] HomeKit requested SwingMode=%s -> %s', this.displayName, value, swing);
    this.cielo.setSwing(this.device, swing);
  }
}

function fahrenheitToCelsius(f: number): number {
  return Math.round(((f - 32) / 1.8) * 10) / 10;
}

function celsiusToFahrenheit(c: number): number {
  return c * 1.8 + 32;
}
