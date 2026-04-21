/**
 * Registry of every server-side plugin. Add a new plugin by creating the
 * module next to this file and appending it here.
 */

import type { GatewayPlugin } from "../lib/plugin-registry";
import { claudeContextPlugin } from "./claude-context";
import { supermemoryPlugin } from "./supermemory";

export const gatewayPlugins: GatewayPlugin[] = [
  claudeContextPlugin,
  supermemoryPlugin,
];
