/**
 * An error we THROW on purpose and that is safe to show the caller.
 * Anything that is not an AppError is a bug, and the API hides its details.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
