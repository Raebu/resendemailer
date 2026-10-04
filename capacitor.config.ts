/// <reference types="@capacitor/background-runner" />
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'global.gibp.mail',
  appName: 'GIBP Mail',
  webDir: 'dist',
  server: { androidScheme: 'https' },
  plugins: {
    CapacitorHttp: { enabled: true },
    CapacitorSQLite: {
      androidIsEncryption: true,
      androidBiometric: {
        biometricAuth: false,
        biometricTitle: 'Unlock GIBP Mail',
        biometricSubTitle: 'Authenticate to access encrypted mail',
      },
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_gibp_mail',
      iconColor: '#C9A852',
    },
  },
};
export default config;
