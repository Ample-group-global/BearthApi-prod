const MAX = 300;
function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, MAX);
  return String(err).slice(0, MAX);
}
export const logger = {
  info(msg: string): void {
    console.log(msg);
  },

  warn(prefix: string, err?: unknown): void {
    const suffix = err !== undefined ? `: ${errMsg(err)}` : "";
    console.warn(`${prefix}${suffix}`);
  },

  error(prefix: string, err?: unknown): void {
    const suffix = err !== undefined ? `: ${errMsg(err)}` : "";
    console.error(`${prefix}${suffix}`);
  },
};
