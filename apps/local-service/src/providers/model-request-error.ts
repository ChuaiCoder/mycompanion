export class ModelRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 502) {
    super(message);
    this.name = "ModelRequestError";
    this.statusCode = statusCode;
  }
}

