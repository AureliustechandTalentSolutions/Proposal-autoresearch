/**
 * Electrobun Configuration
 *
 * Five-panel webview configuration for the Aurelius Autonomous Workbench.
 */

import type { PanelId } from "./src/shared/types";

export interface ElectrobunWebviewConfig {
  id: string;
  title: string;
  url: string;
  width: number;
  height: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  resizable: boolean;
  visible: boolean;
  devtools: boolean;
  transparent: boolean;
  frameless: boolean;
}

export interface ElectrobunConfig {
  appId: string;
  appName: string;
  version: string;
  mainEntry: string;
  webviews: ElectrobunWebviewConfig[];
  tray: {
    icon: string;
    tooltip: string;
  };
  build: {
    outDir: string;
    target: string[];
    minify: boolean;
    sourcemap: boolean;
  };
}

const PORT = parseInt(process.env.WORKBENCH_PORT ?? "8500", 10);
const BASE_URL = `http://localhost:${PORT}`;
const IS_DEV = process.env.NODE_ENV !== "production";

const config: ElectrobunConfig = {
  appId: "com.aurelius.workbench",
  appName: "Aurelius Autonomous Workbench",
  version: "0.1.0",
  mainEntry: "./src/main/index.ts",

  webviews: [
    {
      id: "maestro",
      title: "Maestro - Research Loop",
      url: `${BASE_URL}/maestro`,
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 600,
      resizable: true,
      visible: true,
      devtools: IS_DEV,
      transparent: false,
      frameless: false,
    },
    {
      id: "nemoclaw",
      title: "NemoClaw - Sandbox & Policy",
      url: `${BASE_URL}/nemoclaw`,
      width: 1000,
      height: 700,
      minWidth: 700,
      minHeight: 500,
      resizable: true,
      visible: false,
      devtools: IS_DEV,
      transparent: false,
      frameless: false,
    },
    {
      id: "trigger",
      title: "Trigger - Task Queue",
      url: `${BASE_URL}/trigger`,
      width: 1000,
      height: 600,
      minWidth: 700,
      minHeight: 400,
      resizable: true,
      visible: false,
      devtools: IS_DEV,
      transparent: false,
      frameless: false,
    },
    {
      id: "compliance",
      title: "Compliance Dashboard",
      url: `${BASE_URL}/compliance`,
      width: 1100,
      height: 750,
      minWidth: 800,
      minHeight: 550,
      resizable: true,
      visible: false,
      devtools: IS_DEV,
      transparent: false,
      frameless: false,
    },
    {
      id: "workspace",
      title: "Workspace & Artifacts",
      url: `${BASE_URL}/workspace`,
      width: 1000,
      height: 700,
      minWidth: 700,
      minHeight: 500,
      resizable: true,
      visible: false,
      devtools: IS_DEV,
      transparent: false,
      frameless: false,
    },
  ],

  tray: {
    icon: "./assets/tray-icon.png",
    tooltip: "Aurelius Autonomous Workbench",
  },

  build: {
    outDir: "./dist",
    target: ["linux-x64", "darwin-arm64", "darwin-x64"],
    minify: !IS_DEV,
    sourcemap: IS_DEV,
  },
};

export default config;
