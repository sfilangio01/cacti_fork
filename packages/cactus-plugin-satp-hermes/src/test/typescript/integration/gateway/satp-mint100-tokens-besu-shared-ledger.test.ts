import "jest-extended";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import { BesuTestEnvironment } from "../../test-utils";
import { IBesuConnectionConfig } from "../../environments/besu-test-environment";
import { IFabricConnectionConfig } from "../../environments/fabric-test-environment";
import * as fs from "fs-extra";

const logLevel: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: logLevel,
  label: "SATP - Hermes",
});

let besuEnv: BesuTestEnvironment;
const TIMEOUT = 900000;

let loadedLedgerConfigs: {
  besu: IBesuConnectionConfig;
  ethereum?: any;
};

beforeAll(async () => {
  const configPath = process.env.TEST_ENV_CONFIG_PATH;
  if (!configPath) {
    throw new Error(
      "TEST_ENV_CONFIG_PATH environment variable not set. Global setup likely failed or wasn't run.",
    );
  }
  loadedLedgerConfigs = await fs.readJson(configPath);
  log.info(`Loaded ledger configurations from ${configPath}`);

  besuEnv = await BesuTestEnvironment.connectToExistingEnvironment(
    loadedLedgerConfigs.besu,
  );
  log.info("Connected to existing Besu Ledger successfully.");
}, TIMEOUT);

describe("SATPGateway sending a token from Besu to Fabric", () => {
  jest.setTimeout(TIMEOUT);

  it("should mint 100 tokens to the owner account (initial check)", async () => {
    await besuEnv.mintTokens("100");
    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      besuEnv.getTestOwnerAccount(),
      "100",
      besuEnv.getTestOwnerSigningCredential(),
    );
  });
});
