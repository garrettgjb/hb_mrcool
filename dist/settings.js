"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RECONNECT_MAX_DELAY_SEC = exports.RECONNECT_BASE_DELAY_SEC = exports.TIMER_PONG_TIMEOUT_SEC = exports.TIMER_PING_SEC = exports.TIME_REFRESH_TOKEN_SEC = exports.WEB_USER_AGENT = exports.IOS_USER_AGENT = exports.WEB_X_API_KEY = exports.IOS_X_API_KEY = exports.URL_API_APPLIANCE_INFO = exports.URL_API_DEVICES = exports.URL_API_REFRESH = exports.URL_API_LOGIN = exports.URL_CIELO = exports.URL_API_WSS = exports.URL_API = exports.PLUGIN_NAME = exports.PLATFORM_NAME = void 0;
exports.PLATFORM_NAME = 'MrCoolCielo';
exports.PLUGIN_NAME = 'homebridge-mrcool-cielo';
// Cielo's cloud endpoints. Reverse-engineered from the MRCOOL SmartHVAC / Cielo
// Home mobile apps (see bodyscape/cielo_home for the Home Assistant equivalent).
exports.URL_API = 'api.smartcielo.com';
exports.URL_API_WSS = 'wss.smartcielo.com';
exports.URL_CIELO = 'https://home.cielowigle.com/';
// Login/refresh go through the mobile app's endpoint, not the web login used by
// home.cielowigle.com — the web login is the one gated by a CAPTCHA, the mobile
// endpoint isn't.
exports.URL_API_LOGIN = 'user/smarthvac/login/1';
exports.URL_API_REFRESH = 'user/token/refresh';
exports.URL_API_DEVICES = 'web/devices?limit=420';
exports.URL_API_APPLIANCE_INFO = 'web/sync/db/6';
// Static app keys the iOS app ships with. The login/refresh endpoints require
// the iOS key; the /web/* REST endpoints (device list, appliance info) require
// the web key instead — the iOS key gets a 403 there.
exports.IOS_X_API_KEY = 'T90bwfODtWaIUreVJtroN3itKWquNnUGRYiYUsf0';
exports.WEB_X_API_KEY = '3iCWYuBqpY2g7yRq3yyTk1XCS4CMjt1n9ECCjdpd';
exports.IOS_USER_AGENT = 'MRCOOL SmartHVAC/4.3.0 (com.smarthvac; build:2; iOS 26.5.0) Alamofire/5.9.1';
exports.WEB_USER_AGENT = 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';
exports.TIME_REFRESH_TOKEN_SEC = 3300;
exports.TIMER_PING_SEC = 540;
exports.TIMER_PONG_TIMEOUT_SEC = 60;
exports.RECONNECT_BASE_DELAY_SEC = 10;
exports.RECONNECT_MAX_DELAY_SEC = 300;
//# sourceMappingURL=settings.js.map