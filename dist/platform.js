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
Object.defineProperty(exports, "__esModule", { value: true });
exports.MrCoolCieloPlatform = void 0;
const path = __importStar(require("path"));
const settings_1 = require("./settings");
const cieloApi_1 = require("./cieloApi");
const thermostatAccessory_1 = require("./thermostatAccessory");
class MrCoolCieloPlatform {
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.cachedAccessories = [];
        this.thermostats = new Map();
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
    configureAccessory(accessory) {
        this.cachedAccessories.push(accessory);
    }
    async startCielo(config) {
        const tokenStoragePath = path.join(this.api.user.storagePath(), 'mrcool-cielo-tokens.json');
        this.cielo = new cieloApi_1.CieloApi(this.log, config.email, config.password, tokenStoragePath);
        this.cielo.on('state-update', (device) => {
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
            const wanted = (0, cieloApi_1.normalizeMac)(config.macAddress);
            const match = devices.find((d) => d.macAddress === wanted);
            if (!match) {
                this.log.error('Configured macAddress %s not found. Available devices: %s', config.macAddress, devices.map((d) => `${d.deviceName} (${d.macAddress})`).join(', '));
                return;
            }
            this.registerDevice(match, config.exposeDryMode ?? false);
            return;
        }
        // Otherwise auto-register every device found on the account.
        this.log.info('No macAddress configured - auto-registering all %s device(s) found on the account: %s', devices.length, devices.map((d) => `${d.deviceName} (${d.macAddress})`).join(', '));
        for (const device of devices) {
            this.registerDevice(device, config.exposeDryMode ?? false);
        }
    }
    registerDevice(device, exposeDryMode) {
        const uuid = this.api.hap.uuid.generate(device.macAddress);
        let accessory = this.cachedAccessories.find((a) => a.UUID === uuid);
        if (accessory) {
            this.log.info('Restoring cached accessory for %s', device.deviceName);
            accessory.context.device = device;
            this.api.updatePlatformAccessories([accessory]);
        }
        else {
            this.log.info('Registering new accessory for %s', device.deviceName);
            accessory = new this.api.platformAccessory(device.deviceName, uuid);
            accessory.context.device = device;
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
        }
        const thermostat = new thermostatAccessory_1.ThermostatAccessory(this, accessory, this.cielo, device, device.deviceName, exposeDryMode);
        this.thermostats.set(device.macAddress, thermostat);
    }
}
exports.MrCoolCieloPlatform = MrCoolCieloPlatform;
//# sourceMappingURL=platform.js.map