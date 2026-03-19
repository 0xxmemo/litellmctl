// Mutable live bindings — set once at startup via initConfig()
export let LITELLM_URL = "http://localhost:4040";
export let LITELLM_AUTH = "";
export let CONFIG_PATH = "";
export let PORT = 14041;

export function initConfig(litellmUrl: string, masterKey: string, configPath: string, port: number) {
  LITELLM_URL = litellmUrl;
  LITELLM_AUTH = `Bearer ${masterKey}`;
  CONFIG_PATH = configPath;
  PORT = port;
}
