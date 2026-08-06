export class ControlPlaneValidationError extends Error {
  readonly code: string = "DOMAIN_VALIDATION_FAILED";

  constructor(
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ControlPlaneValidationError";
  }
}
