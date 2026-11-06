export const calloutKinds = ['NOTE', 'WARNING', 'IMPORTANT'] as const;
export type CalloutKind = typeof calloutKinds[number];

export const calloutTitleMaxLength = 120;
export function isCalloutKind(value: unknown): value is CalloutKind {
  return typeof value === 'string' && (calloutKinds as readonly string[]).includes(value);
}

export function isCalloutTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length <= calloutTitleMaxLength
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    && value === value.trim();
}
