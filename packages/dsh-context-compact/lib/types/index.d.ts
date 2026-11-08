export const name: string;
export const inject: string[];
export function apply(ctx: any): void;
export default { name: typeof name; inject: typeof inject; apply: typeof apply };
