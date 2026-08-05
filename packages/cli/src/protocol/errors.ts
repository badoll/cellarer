import type { CliError } from "@cellarer/core";

export class CliHandledError extends Error {
  readonly cliError: CliError;

  constructor(cliError: CliError) {
    super(cliError.message);
    this.name = "CliHandledError";
    this.cliError = cliError;
  }
}
