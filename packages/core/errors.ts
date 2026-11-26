/** An error the API answers with its status and message. */
export class ZirbelError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
