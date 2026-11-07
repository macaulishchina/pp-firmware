import { defineConfig } from "./src/app-config";

export default defineConfig({
  title: "PP 固件中心",
  projectName: "pp-firmware",
  storagePrefix: "pp-firmware",
  defaults: {
    sidebarCollapsed: false,
    darkMode: false,
    language: "zh",
  },
  logo: {
    minimal: {
      light: {
        src: "assets/img/logo/esp.svg",
        width: 26,
        height: 32,
      },
      dark: {
        src: "assets/img/logo/esp.svg",
        width: 26,
        height: 32,
      },
    },
    full: {
      light: {
        src: "assets/img/logo/logo_light.svg",
        width: 240,
        height: 36,
      },
      dark: {
        src: "assets/img/logo/logo_dark.svg",
        width: 240,
        height: 36,
      },
    },
  },
  favicon: "assets/favicon.ico",
  i18n: {
    supportedLanguages: ["en", "zh"],
  },
  hideFooter: true,
  dateFormat: "dd/MM/yyyy HH:mm:ss",
  landingPage: {
    onboardingLayoutBackgroundImage: "assets/img/backgrounds/e22-home-banner.png",
    onboardingHeading: "Easily flash your ESP dev kits using <gradient-text>ESP Launchpad</gradient-text> Flashing Utility"
  },
});
