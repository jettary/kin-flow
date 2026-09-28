export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function requireThat(value: unknown, message: string, status = 400): asserts value {
  if (!value) throw new AppError(status, message);
}
