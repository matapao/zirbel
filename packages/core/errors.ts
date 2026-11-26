/** An error the API answers with its status and message. */
export class ZirbelError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
