export type QuickCredentials = { email: string; password: string };

function randomHex(bytes: number) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

// Reserved .invalid domain: this is a login identifier, never a real mailbox.
// No fallback to Math.random, and no browser persistence of plaintext passwords.
export function generateCredentials(): QuickCredentials {
  return { email: `sd_${randomHex(12)}@account.invalid`, password: `Sd!${randomHex(16)}` };
}

export function credentialsText(credentials: QuickCredentials, origin: string) {
  return [
    "沉淀 · 账号保存卡",
    `登录地址：${new URL(origin).origin}`,
    `账号：${credentials.email}`,
    `密码：${credentials.password}`,
    "",
    "请妥善保管账号和密码，不要分享给他人。此文件包含明文密码。",
    "此账号不是邮箱，不能接收邮件；丢失账密可能无法找回。",
    "建议存入可信的密码管理器；请勿把此文件留在共享设备。",
  ].join("\n");
}
