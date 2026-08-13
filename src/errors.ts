export class PublisherError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly nextActions: Array<{ tool: string; required?: boolean; args?: Record<string, unknown> }> = [],
  ) {
    super(message);
    this.name = "PublisherError";
  }
}
