export const PLATFORM_NAME = 'MrCoolCielo';
export const PLUGIN_NAME = 'homebridge-mrcool-cielo';

// Cielo's cloud endpoints. Reverse-engineered from the MRCOOL SmartHVAC / Cielo
// Home mobile apps (see bodyscape/cielo_home for the Home Assistant equivalent).
export const URL_API = 'api.smartcielo.com';
export const URL_API_WSS = 'wss.smartcielo.com';
export const URL_CIELO = 'https://home.cielowigle.com/';

// Login/refresh go through the mobile app's endpoint, not the web login used by
// home.cielowigle.com — the web login is the one gated by a CAPTCHA, the mobile
// endpoint isn't.
export const URL_API_LOGIN = 'user/smarthvac/login/1';
export const URL_API_REFRESH = 'user/token/refresh';
export const URL_API_DEVICES = 'web/devices?limit=420';
export const URL_API_APPLIANCE_INFO = 'web/sync/db/6';

// Static app keys the iOS app ships with. The login/refresh endpoints require
// the iOS key; the /web/* REST endpoints (device list, appliance info) require
// the web key instead — the iOS key gets a 403 there.
export const IOS_X_API_KEY = 'T90bwfODtWaIUreVJtroN3itKWquNnUGRYiYUsf0';
export const WEB_X_API_KEY = '3iCWYuBqpY2g7yRq3yyTk1XCS4CMjt1n9ECCjdpd';

export const IOS_USER_AGENT =
  'MRCOOL SmartHVAC/4.3.0 (com.smarthvac; build:2; iOS 26.5.0) Alamofire/5.9.1';
export const WEB_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36';

export const TIME_REFRESH_TOKEN_SEC = 3300;
export const TIMER_PING_SEC = 540;
export const TIMER_PONG_TIMEOUT_SEC = 60;
export const RECONNECT_BASE_DELAY_SEC = 10;
export const RECONNECT_MAX_DELAY_SEC = 300;
