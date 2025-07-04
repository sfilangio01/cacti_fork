// src/test/typescript/jest.setup-after-env.ts
import * as fs from "fs-extra";
import * as path from "path";
import { IBesuConnectionConfig } from "./environments/besu-test-environment";
import { IFabricConnectionConfig } from "./environments/fabric-test-environment"; // NEW: Import Fabric config interface
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";

const LOG_LEVEL: LogLevelDesc = "INFO";
const log = LoggerProvider.getOrCreate({
  level: LOG_LEVEL,
  label: "JestSetupAfterEnv",
});

// Declare global variable type extension so TypeScript knows about it.
// This variable will hold the deserialized Besu and Fabric connection configurations.
declare global {
  // eslint-disable-next-line no-var
  var __ALL_TEST_ENV_CONFIG__: {
    besu: IBesuConnectionConfig;
    fabric: IFabricConnectionConfig;
    // Ethereum here when ready
  };
}

/**
 * Jest setup hook that runs once before each test file (or environment)
 * after the global setup has completed.
 * It loads the shared Besu and Fabric ledger connection configurations into the test environment's global scope.
 */
beforeAll(async () => {
  const tempConfigPath = process.env.TEST_ENV_CONFIG_PATH;

  if (!tempConfigPath) {
    const errorMessage =
      "Environment variable TEST_ENV_CONFIG_PATH is not set. " +
      "This indicates that Jest's global setup (jest.global-setup.ts) did not run " +
      "or failed to set the path to the temporary configuration file.";
    log.error(errorMessage);
    throw new Error(errorMessage);
  }

  if (!fs.existsSync(tempConfigPath)) {
    const errorMessage =
      `Temporary configuration file not found at ${tempConfigPath}. ` +
      "This suggests an issue with the global setup not creating the file " +
      "or an incorrect path being provided.";
    log.error(errorMessage);
    throw new Error(errorMessage);
  }

  try {
    // Read the JSON configuration from the temporary file.
    const config = await fs.readJson(tempConfigPath);
    // Assign the configuration to a global variable accessible within this test worker process.
    (global as any).__ALL_TEST_ENV_CONFIG__ = config; // NEW: Store all configs
    log.debug(
      "Successfully loaded ALL Test Environment Configurations into global context for test worker.",
    );
  } catch (error: any) {
    const errorMessage = `Failed to load ALL Test Environment Configurations from ${tempConfigPath}: ${error.message}`;
    log.error(errorMessage);
    throw new Error(errorMessage);
  }
}, 30000);
