import * as fs from "fs-extra";
import * as path from "path";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import {
  Containers,
  pruneDockerAllIfGithubAction,
} from "@hyperledger/cactus-test-tooling";
import { BesuTestEnvironment } from "./environments/besu-test-environment";
import { FabricTestEnvironment } from "./environments/fabric-test-environment";

const LOG_LEVEL: LogLevelDesc = "INFO";
const log = LoggerProvider.getOrCreate({
  level: LOG_LEVEL,
  label: "JestGlobalTeardown",
});

const TEMP_CONFIG_FILE = path.join(process.cwd(), ".test-env-config.json");

/**
 * Jest Global Teardown function.
 * This function is executed once after all test suites have completed.
 * It is responsible for stopping and destroying ALL ledgers.
 */
module.exports = async function globalTeardown() {
  log.info("Jest Global Teardown: Stopping ALL Ledgers...");

  const besuEnv: BesuTestEnvironment = (global as any).__BESU_LEDGER_ENV__;
  const fabricEnv: FabricTestEnvironment = (global as any)
    .__FABRIC_LEDGER_ENV__;

  if (besuEnv) {
    await besuEnv.tearDown();
    log.info("Besu Ledger torn down successfully.");
  }

  if (fabricEnv) {
    await fabricEnv.tearDown();
    log.info("Fabric Ledger torn down successfully.");
  }

  // Clean up the temporary config file
  if (fs.existsSync(TEMP_CONFIG_FILE)) {
    await fs.remove(TEMP_CONFIG_FILE);
    log.info(`Removed temporary config file: ${TEMP_CONFIG_FILE}`);
  }

  try {
    await pruneDockerAllIfGithubAction({ logLevel: LOG_LEVEL });
    log.info("Docker pruning successful.");
  } catch (error: any) {
    log.error(`Docker pruning failed: ${error.message}`);
    await Containers.logDiagnostics({ logLevel: LOG_LEVEL });
    throw error;
  }

  log.info("Jest Global Teardown: All Ledgers stopped and cleaned up.");
};
