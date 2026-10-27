// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));
  gladys.onDeviceDeleted((device) => app.deviceDeleted(device));

  // The commands. A failure is logged here (never the value of a secret: there is none in a command).
  gladys.onSetValue(async (device, feature, value) => {
    try {
      return await app.setValue(device, feature, value);
    } catch (err) {
      logger?.warn(`Command ${feature?.external_id} refused: ${err.message}`);
      throw err;
    }
  });

  gladys.onAction(ACTIONS.TEST_CONNECTION, () => app.testConnection());
  gladys.onConfigUpdated((config) => app.configUpdated(config));

  // Connection lifecycle (also after every reconnection to Gladys). The app
  // reads the configuration itself and retries without end when it fails.
  gladys.on('connected', () => {
    app.connected(() => gladys.getConfig()).catch((err) => logger?.error('Start failed', err));
  });
}
