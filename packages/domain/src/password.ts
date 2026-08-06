// 密码策略（纯领域规则，无副作用）。
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export function validateNewPassword(password: string): string[] {
  const errors: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push(`密码至少 ${PASSWORD_MIN_LENGTH} 个字符`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    errors.push(`密码最多 ${PASSWORD_MAX_LENGTH} 个字符`);
  }
  return errors;
}

export function isValidPassword(password: string): boolean {
  return validateNewPassword(password).length === 0;
}
