/**
 * An error a route throws to answer with a specific status.
 *
 * The server's error handler turns it into `{ error, details }` with
 * `statusCode`; anything else that escapes a route is answered as a 500.
 */
export class HttpProblem extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
  }
}
